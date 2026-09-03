-- ADR-0022: a second SECURITY DEFINER lookup on the role ADR-0020 provisioned,
-- so that `POST /api/v1/invitations/accept` can find out which organisation an
-- invitation belongs to.
--
-- THE PROBLEM, AND IT IS ADR-0020'S PROBLEM EXACTLY. Accepting an invitation is
-- the second question in Phase 2 that no tenant context can answer, and for a
-- sharper reason than the first: the person accepting is a member of NOTHING.
-- `Session.activeOrganizationId` is null for them, the authorization guard
-- resolves no tenant, and `withTenantTransaction` has no id to `SET LOCAL`. The
-- invitation row names the organisation — that is the fact being looked up —
-- so the handler cannot open the transaction that would let it read the row
-- that would tell it which transaction to open.
--
-- `Invitation` carries ENABLE/FORCE ROW LEVEL SECURITY with the policy
-- `"organizationId" = current_setting('app.organization_id', true)`
-- (20260820121229_row_level_security), and the API connects as `sentinel_app`,
-- which is neither SUPERUSER nor BYPASSRLS. Measured on this database on
-- 2026-09-03, as `sentinel_app`, in one transaction, looking a row up by its
-- `tokenHash` — the only handle the acceptor has:
--
--     -- no app.organization_id set at all:            0 rows
--     -- SET LOCAL app.organization_id = <owning org>: 1 row
--     -- SET LOCAL app.organization_id = <other org>:  0 rows
--
-- So the naive `prisma.invitation.findUnique({ where: { tokenHash } })`
-- compiles, passes review, and returns null for every invitation ever sent.
--
-- WHAT THIS FUNCTION RETURNS, AND WHY IT IS ONE COLUMN. The organisation id,
-- and nothing else. It makes no policy decision: it does not filter on
-- `acceptedAt`, `revokedAt` or `expiresAt`, and it does not look at the invited
-- address. Every one of those is a decision with a status code attached, and
-- all of them stay in the handler, which reads the full row under ordinary RLS
-- once the tenant transaction is open. The bypass is therefore a pure
-- key-to-tenant lookup and the rules remain where a reader of the module can
-- find them. Widening this function to return the row would move authorization
-- logic inside the one construct in this schema that ignores RLS, which is the
-- opposite of what it is for.
--
-- WHY THE ARGUMENT IS SAFE TO ACCEPT FROM A REQUEST. `p_token_hash` is a
-- SHA-256 of a 256-bit random token that exists only in the invited person's
-- inbox. There is no enumeration: a caller who can supply a matching hash
-- already holds the credential, and all they learn is an opaque organisation
-- id they cannot then act on — every subsequent read and write in the accept
-- path runs under RLS in a transaction scoped to that id, and acceptance still
-- requires being authenticated as the invited address. Contrast
-- `user_organizations(text)`, whose argument is a user id and whose comment
-- therefore has to insist it comes from the session and never from a path
-- parameter. That warning does not apply here, and the difference is the
-- unguessability of the argument, not a weaker rule.
--
-- WHY THE EXISTING ROLE RATHER THAN A NEW ONE. ADR-0020 says
-- `sentinel_org_lookup` "exists only to own it", singular, and that sentence
-- stops being true here; ADR-0022 records the widening rather than editing an
-- immutable ADR. The alternative — one BYPASSRLS role per definer function —
-- was considered and rejected by the operator on 2026-09-03: it adds a second
-- role that every deployment must provision out of band before migrations will
-- apply (carry-forward ruling 96), and two roles each bypassing RLS for one
-- narrow function are not meaningfully safer than one role bypassing it for
-- two. What contains the bypass is the fixed predicate and the single returned
-- column in each function body, not the number of owners.
--
-- `SET search_path = public, pg_temp` WITH pg_temp LAST, FIRST TIME, ON
-- PURPOSE. ADR-0021 had to correct `user_organizations` for exactly this:
-- listing `public` alone leaves the temporary schema implicitly ahead of it for
-- relation names, so a caller holding TEMPORARY can create a shadowing
-- `pg_temp."Invitation"` and have a definer function read it instead. The
-- attack was measured in that migration and reproduced at 1 row versus 0. This
-- function is written with the pin from the start rather than shipped weak and
-- corrected forward. `20260903090000_revoke_temporary_from_public` since
-- removed TEMPORARY from PUBLIC as well, so this is now the second of two
-- independent defences and neither is load-bearing alone.
--
-- THE GRANT IS NOT DECORATION. `sentinel_org_lookup` owns nothing and inherits
-- nothing, and the previous migration measured what that costs when the grant
-- is missing: `ERROR: relation "Invitation" does not exist`, which names a
-- missing table rather than a missing privilege and sends the reader looking in
-- the wrong place. It already holds `USAGE ON SCHEMA public` and SELECT on
-- `Membership` and `Organization`; this adds SELECT on one more table. There
-- are still no default privileges, so a table added by a later migration stays
-- invisible to this role until somebody grants it deliberately.
--
-- SOUNDNESS ON ITS OWN (carry-forward ruling 1): this migration adds one
-- function and two privileges. It creates no table, changes no column, and
-- relaxes no policy. `sentinel_app` is unchanged except for EXECUTE on one more
-- function — the measurement at the top of this comment stays true after this
-- migration. A database that stops after it is in the same state as one that
-- stopped before it, plus one read path.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_org_lookup') THEN
    RAISE EXCEPTION
      'role "sentinel_org_lookup" does not exist'
      USING
        DETAIL  = 'ADR-0020 and ADR-0022 require a NOLOGIN NOINHERIT BYPASSRLS role to own the definer lookups. Creating a BYPASSRLS role needs superuser, so this migration cannot create it.',
        HINT    = 'Run infra/docker/postgres/init/01-app-role.sql as a superuser, or: CREATE ROLE sentinel_org_lookup NOLOGIN NOINHERIT BYPASSRLS;',
        ERRCODE = 'undefined_object';
  END IF;
END
$$;

CREATE FUNCTION public.invitation_organization_by_token_hash(p_token_hash text)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $fn$
  SELECT i."organizationId"
  FROM "Invitation" i
  WHERE i."tokenHash" = p_token_hash;
$fn$;

COMMENT ON FUNCTION public.invitation_organization_by_token_hash(text) IS
  'ADR-0022. The organisation an invitation belongs to, found by the SHA-256 hash of its token. SECURITY DEFINER, owned by sentinel_org_lookup (BYPASSRLS), because Invitation carries FORCE ROW LEVEL SECURITY and the person accepting is a member of no organisation, so no tenant context can be set before the row is read. Returns one column and makes no policy decision: liveness, expiry and the invited-address binding are all decided by the handler, under RLS, in a tenant transaction scoped to the id this returns. search_path pins pg_temp LAST, per ADR-0021.';

ALTER FUNCTION public.invitation_organization_by_token_hash(text) OWNER TO sentinel_org_lookup;

GRANT SELECT ON TABLE "Invitation" TO sentinel_org_lookup;

REVOKE EXECUTE ON FUNCTION public.invitation_organization_by_token_hash(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.invitation_organization_by_token_hash(text) TO sentinel_app;
