# ADR-0020: The caller's own organisation list is read through one `SECURITY DEFINER` function owned by a dedicated `BYPASSRLS` role

**Status:** Superseded by [ADR-0021](ADR-0021-definer-search-path-pins-pg-temp-last.md) · **Date:** 2026-09-02

## Context

Phase 2 Task 13 ships `GET /api/v1/organizations`, which lists **the organisations the caller
belongs to**. It is the first and — in Phase 2 — the only endpoint whose question spans more than
one organisation. Every other route in the phase names exactly one, resolved from
`Session.activeOrganizationId` by `TenantContextGuard`, and runs inside `withTenantTransaction`.

That mechanism cannot answer this question, because the question is *which* organisations. You
cannot open a tenant transaction for an organisation you are trying to discover.

The obstruction is row-level security, and it is not theoretical. `Membership` carries
`ENABLE`/`FORCE ROW LEVEL SECURITY` with the policy
`USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`
(`packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql:12-16`), and the
API connects as `sentinel_app`, which has neither `SUPERUSER` nor `BYPASSRLS`.

**Measured** against the compose Postgres on 2026-09-02, with one user holding two `ACTIVE`
memberships in two organisations, connected as `sentinel_app`:

```
=== A: no app.organization_id, plain cross-org read ===
SELECT m.id, m."organizationId" FROM "Membership" m WHERE m."userId" = 'usr_probe_t13';
 id | organizationId
----+----------------
(0 rows)

=== B: app.organization_id = org_probe_t13a ===
       id       | organizationId
----------------+----------------
 mem_probe_t13a | org_probe_t13a
(1 row)
```

So the naive implementation — `prisma.membership.findMany({ where: { userId } })` — returns an
empty list for every user who has organisations. It compiles, it passes review, and it is wrong in
exactly the way `active-organization.store.ts` records the Task 9 reviewer finding by mutation.

**The second measurement is the one that decided this ADR.** `SECURITY DEFINER` alone does not
solve it. `FORCE ROW LEVEL SECURITY` binds the table owner too — that is what `FORCE` means and why
the Phase 1 migration uses it — so a definer function is subject to the policy unless its owner can
bypass RLS. Measured the same day, with a `NOINHERIT`, non-superuser role owning the function:

```
-- probe_definer: rolsuper = f, rolbypassrls = f
=== as sentinel_app, no tenant context, calling the definer function ===
 org_id | slug
--------+------
(0 rows)

-- then: ALTER ROLE probe_definer BYPASSRLS;  (rolsuper = f, rolcanlogin = f)
     org_id     |    slug
----------------+-------------
 org_probe_t13a | probe-t13-a
 org_probe_t13b | probe-t13-b
(2 rows)
```

**This is a trap that local development would have hidden.** The compose stack's schema owner
`sentinel` is `rolsuper = t, rolbypassrls = t`, so a definer function owned by the migration role
works locally without anyone deciding that it should. The integration harness is worse: per
carry-forward ruling 58, `auth-harness.ts` binds the application under test to the schema owner's
DSN, so RLS cannot bite there at all. A `SECURITY DEFINER` function relying on an incidentally
privileged owner would have passed every test in this repository and returned an empty organisation
list in any production where the migration role is not a superuser — which is every production
worth deploying.

## Decision

One database function, owned by one role that exists only to own it.

```sql
CREATE ROLE sentinel_org_lookup NOLOGIN NOINHERIT BYPASSRLS;

CREATE FUNCTION user_organizations(p_user_id text)
  RETURNS TABLE (...)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT ...
  FROM "Membership" m
  JOIN "Organization" o ON o.id = m."organizationId"
  WHERE m."userId" = p_user_id
    AND m."deletedAt" IS NULL
    AND m.status = 'ACTIVE';
$$;

ALTER FUNCTION user_organizations(text) OWNER TO sentinel_org_lookup;
REVOKE EXECUTE ON FUNCTION user_organizations(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION user_organizations(text) TO sentinel_app;
```

Four properties carry the decision, and each is a property of the database rather than of anybody's
discipline:

- **The predicate is fixed in the function body.** A caller supplies a `userId` and nothing else.
  There is no filter, no ordering and no column list a call site can influence, so there is no way
  to widen the read short of editing a migration.
- **The bypass is confined to one function.** `sentinel_org_lookup` cannot log in, inherits nothing,
  owns nothing else, and is not granted to anybody. `BYPASSRLS` on it is not a capability the
  application holds; it is a capability one `SELECT` statement holds.
- **`sentinel_app` is unchanged.** It still cannot read `Membership` across organisations —
  measurement A above stays true after this migration. It gains `EXECUTE` on one function.
- **`SET search_path = public`** closes the standard `SECURITY DEFINER` hijack, where a caller
  creates a shadowing object in a schema earlier on the path.

The `userId` passed in comes from the authenticated session — `request.principal`, set by
`AuthenticationGuard` — never from a path parameter, a query string or a body. This is
carry-forward ruling 9's rule applied to a user-owned read: a handler taking a `userId` from a
request must prove the caller *is* that user, and taking it from the resolved session is the proof.

The route is `@AuthenticatedOnly()`, not `@RequirePermission()`. "Which organisations do I belong
to" is a question about a user and about no tenant, which is `security/authentication.md` §1's
separation expressed at the route, and it is the set of routes `access.decorator.ts` already
describes `@AuthenticatedOnly()` as existing for — *"listing the organisations you belong to,
switching between them"*.

## Alternatives considered

**A second permissive RLS policy on `Membership`, keyed on a `app.user_id` GUC.** Postgres ORs
permissive policies, so `USING ("userId" = current_setting('app.user_id', true))` alongside the
tenant policy would make the read work with no new role and no privileged definer. It loses on two
counts. The policy is live on **every** `SELECT` against `Membership`, including those inside a
tenant transaction, so its containment depends on no other code path ever setting `app.user_id` —
an invariant held by remembering, which is the class this phase's ledger is a list of failures of.
And it is not a real second layer: any role may set a custom GUC, so `sentinel_app` — the role
whose bugs layer 2 exists to catch — could set `app.user_id` itself and read any user's
memberships. It would document an intention rather than enforce one.

**A `SECURITY DEFINER` function owned by the migration role.** The obvious form of the decision
above, and the form this ADR started as. Rejected on the second measurement: it works if and only
if the migration role happens to hold `BYPASSRLS`, it does so silently, and both the local stack and
the integration harness hold that property incidentally. The failure mode is an empty list in
production with a green test suite. A dedicated role makes the requirement explicit and identical in
every environment.

**Drop the endpoint from Phase 2 and derive the list client-side.** There is nothing to derive it
from. The session document names at most the *active* organisation, and Task 17's organisation
switcher cannot render a list it cannot fetch.

**`ALTER TABLE "Membership" NO FORCE ROW LEVEL SECURITY`.** Would let a definer function owned by
the table owner read freely. Rejected outright: the Phase 1 migration's own comment explains that
`FORCE` is what stops row-level security being "decorative in any environment where the app and the
owner are the same role". Weakening the isolation layer to add a convenience endpoint inverts the
priority in `CLAUDE.md`'s second critical rule.

## Consequences

**A new role must exist before the migration runs**, exactly as `sentinel_app` must — the roadmap's
fresh-database evidence row and carry-forward ruling 96 both record that the migration history is
not self-contained for that reason. `sentinel_org_lookup` joins it in
`infra/docker/postgres/init/01-app-role.sql`, and the first deployment runbook gains a second
`CREATE ROLE`. **Creating a `BYPASSRLS` role requires superuser**, so this is a provisioning step a
platform operator performs once, not something a migration can do for itself in a managed database
where the application's own role is not a superuser.

**A green local test suite no longer implies the function is reachable in production**, and the
mitigation is a test rather than a note: the migration integration spec must assert
`rolbypassrls = true` and `rolcanlogin = false` on `sentinel_org_lookup` and that `EXECUTE` is
granted to `sentinel_app` and revoked from `PUBLIC`. Without those assertions this ADR's whole
argument rests on a role attribute nothing checks.

**There is now one `BYPASSRLS` object in the system**, and it is a real reduction in the
"two independent mechanisms must both be wrong" property ADR-0006 claims. For this one query, layer
2 is deliberately switched off and layer 1 is the fixed `WHERE` clause in the function body. That is
the cost, it is stated rather than implied, and the containment argument above is what makes it
acceptable: the bypass is not held by the application, and the statement it applies to cannot be
changed without a migration.

**A caller can still ask about the wrong user** if a bug passes the wrong `userId`. No design
considered here removes that; the function's input has to be a user id for the endpoint to exist.
What the decision does is make that the *only* remaining failure mode, and it is one an integration
test can pin directly.

**Every later cross-organisation question needs its own decision, not this function.** Phase 3's
project and asset lists, Phase 11's platform admin, and any future "across all tenants" report are
out of scope here. This ADR licenses exactly one query shape — a user's own memberships — and a
second consumer of `user_organizations` reading it for a different purpose is a signal to write the
next ADR rather than to widen this function.
