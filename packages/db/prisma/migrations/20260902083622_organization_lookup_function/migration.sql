-- ADR-0020: one SECURITY DEFINER function, owned by one role that exists only
-- to own it, so that "which organisations do I belong to" can be answered at
-- all.
--
-- THE PROBLEM. `GET /api/v1/organizations` is the one question in Phase 2 that
-- spans organisations. Every other route names exactly one, resolved from
-- `Session.activeOrganizationId` and entered through `withTenantTransaction`,
-- which issues `SET LOCAL app.organization_id`. That mechanism cannot answer
-- this question: you cannot open a tenant transaction for an organisation you
-- are trying to discover.
--
-- `Membership` carries ENABLE/FORCE ROW LEVEL SECURITY with the policy
-- `"organizationId" = current_setting('app.organization_id', true)`
-- (20260820121229_row_level_security), and the API connects as `sentinel_app`,
-- which is neither SUPERUSER nor BYPASSRLS. Measured on this database on
-- 2026-09-02, as `sentinel_app`, for a user holding two ACTIVE memberships:
--
--     SELECT m.id, m."organizationId" FROM "Membership" m
--       WHERE m."userId" = 'usr_probe_d2';
--      id | organizationId
--     ----+----------------
--     (0 rows)
--
-- So the naive `prisma.membership.findMany({ where: { userId } })` compiles,
-- passes review, and returns an empty list for every user who has
-- organisations.
--
-- WHY SECURITY DEFINER IS NOT ENOUGH ON ITS OWN. FORCE ROW LEVEL SECURITY binds
-- the table owner too — that is what FORCE means, and the Phase 1 migration
-- chose it precisely so RLS is not decorative where the app and the owner are
-- the same role. A definer function is therefore subject to the policy unless
-- its owner can bypass RLS. Measured the same day, with the function created
-- exactly as below and its owner's attribute flipped:
--
--     -- ALTER ROLE sentinel_org_lookup NOBYPASSRLS;
--     SELECT id, slug FROM user_organizations('usr_probe_d2');
--      id | slug
--     ----+------
--     (0 rows)
--     -- ALTER ROLE sentinel_org_lookup BYPASSRLS;
--          id        |   slug
--     ---------------+-----------
--      org_probe_d2  | probe-d2
--      org_probe_d2b | probe-d2b
--     (2 rows)
--
-- This is a trap local development would have hidden: the compose schema owner
-- `sentinel` is rolsuper = t, rolbypassrls = t, so a function owned by the
-- migration role works here without anyone deciding that it should, and fails
-- in any production where the migration role is not a superuser.
--
-- THE ROLE MUST ALREADY EXIST, AND THIS MIGRATION CANNOT CREATE IT. Creating a
-- BYPASSRLS role requires superuser, which the migration role is not in a
-- managed database. `sentinel_org_lookup` is therefore provisioned out of band,
-- beside `sentinel_app`, in infra/docker/postgres/init/01-app-role.sql — the
-- same out-of-band precondition carry-forward ruling 96 records for
-- `sentinel_app`. The guard below turns its absence into a named error rather
-- than an ALTER FUNCTION failure blaming a role nobody has heard of.
--
-- THE TWO GRANTS BELOW ARE NOT DECORATION, AND ADR-0020's SKETCH OMITTED THEM.
-- A SECURITY DEFINER function executes with the owner's privileges, and
-- `sentinel_org_lookup` owns nothing else and inherits nothing. Measured, with
-- the function created and owned as the ADR sketches it and no grants at all:
--
--     SELECT id, slug FROM user_organizations('usr_probe_d2');
--     ERROR:  relation "Membership" does not exist
--     -- after GRANT USAGE ON SCHEMA public:
--     ERROR:  permission denied for table Membership
--     -- after GRANT SELECT ON "Membership", "Organization": 2 rows.
--
-- The first error is the more dangerous of the two, because it names a missing
-- table rather than a missing privilege. SELECT on exactly two tables, and no
-- default privileges: a table added by a later migration is invisible to this
-- role until somebody grants it deliberately.
--
-- WHAT CONTAINS THE BYPASS. The predicate is fixed in the function body: a
-- caller supplies a user id and nothing else, so there is no filter, no
-- ordering and no column list a call site can widen without editing a
-- migration. `sentinel_app` is unchanged — the measurement at the top of this
-- comment stays true after this migration — and gains EXECUTE on one function.
-- `SET search_path = public` closes the standard definer hijack, where a caller
-- creates a shadowing object in a schema earlier on the path. EXECUTE is
-- revoked from PUBLIC, which Postgres grants by default on every new function.
--
-- SOUNDNESS ON ITS OWN (carry-forward ruling 1): this migration adds one
-- function and three privileges. It creates no table, changes no column and
-- relaxes no policy, so a database that stops after it is in the same state as
-- one that stopped before it, plus one read path.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_org_lookup') THEN
    RAISE EXCEPTION
      'role "sentinel_org_lookup" does not exist'
      USING
        DETAIL  = 'ADR-0020 requires a NOLOGIN NOINHERIT BYPASSRLS role to own user_organizations(text). Creating a BYPASSRLS role needs superuser, so this migration cannot create it.',
        HINT    = 'Run infra/docker/postgres/init/01-app-role.sql as a superuser, or: CREATE ROLE sentinel_org_lookup NOLOGIN NOINHERIT BYPASSRLS;',
        ERRCODE = 'undefined_object';
  END IF;
END
$$;

CREATE FUNCTION public.user_organizations(p_user_id text)
  RETURNS TABLE (
    id          text,
    slug        text,
    name        text,
    status      "OrganizationStatus",
    "createdAt" timestamptz,
    "updatedAt" timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $fn$
  SELECT o.id, o.slug, o.name, o.status, o."createdAt", o."updatedAt"
  FROM "Membership" m
  JOIN "Organization" o ON o.id = m."organizationId"
  WHERE m."userId" = p_user_id
    AND m."deletedAt" IS NULL
    AND m.status = 'ACTIVE';
$fn$;

COMMENT ON FUNCTION public.user_organizations(text) IS
  'ADR-0020. The organisations one user is an ACTIVE, non-deleted member of. SECURITY DEFINER, owned by sentinel_org_lookup (BYPASSRLS), because Membership carries FORCE ROW LEVEL SECURITY and this question spans organisations. The user id must come from the authenticated session, never from a path parameter, query string or body.';

ALTER FUNCTION public.user_organizations(text) OWNER TO sentinel_org_lookup;

GRANT USAGE ON SCHEMA public TO sentinel_org_lookup;
GRANT SELECT ON TABLE "Membership", "Organization" TO sentinel_org_lookup;

REVOKE EXECUTE ON FUNCTION public.user_organizations(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.user_organizations(text) TO sentinel_app;
