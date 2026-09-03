# ADR-0022: Invitation acceptance resolves its tenant through a second `SECURITY DEFINER` lookup on the existing `BYPASSRLS` role

**Status:** Accepted · **Date:** 2026-09-03

## Context

Phase 2 Task 15 ships `POST /api/v1/invitations/accept`. It is the second endpoint in this phase
whose question no tenant context can answer, and its version of the problem is sharper than
[ADR-0020](ADR-0020-cross-organisation-membership-lookup.md)'s.

`GET /api/v1/organizations` at least belongs to somebody who has organisations. **The person
accepting an invitation is a member of nothing.** Their `Session.activeOrganizationId` is null,
`TenantContextGuard` resolves no tenant, and `withTenantTransaction` has no id to `SET LOCAL`. The
only handle they hold is the token from their inbox, and the row that token names is the very row
that would say which organisation to scope to. The handler cannot open the transaction that would
let it read the row that would tell it which transaction to open.

`Invitation` carries `ENABLE`/`FORCE ROW LEVEL SECURITY` with the policy
`("organizationId" = current_setting('app.organization_id', true))`
(`packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql:18-20`), and the
API connects as `sentinel_app`. **Measured** on 2026-09-03 against the compose Postgres:

```
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='sentinel_app';
 sentinel_app | f | f
```

And with one live invitation in place, inside one transaction, `SET LOCAL ROLE sentinel_app`:

```
 A. direct read, no org set        | 0
 B. definer function, no org set   | org_probe_t15
 C. definer function, wrong hash   | NULL
 D. direct read, correct org set   | 1
```

Row A is the defect: `prisma.invitation.findUnique({ where: { tokenHash } })` compiles, passes
review, and returns null for every invitation ever sent. Row D is why the fix can be small — once
an organisation id is in hand, everything else the accept path does works under ordinary RLS.

## Decision

**Add one `SECURITY DEFINER` function, `public.invitation_organization_by_token_hash(text)`,
owned by the existing `sentinel_org_lookup` role, returning the organisation id and nothing else.**

`packages/db/prisma/migrations/20260904020000_invitation_lookup_function/migration.sql`.

Three properties make this a narrow decision rather than a general RLS escape hatch:

1. **One column, no policy.** The function does not filter on `acceptedAt`, `revokedAt` or
   `expiresAt`, and does not look at the invited address. Every one of those is a decision with a
   status code attached, and all of them stay in the handler, which reads the full row under
   ordinary RLS inside a tenant transaction scoped to the id this returns. Widening the function to
   return the row would move authorization logic inside the one construct in this schema that
   ignores RLS.
2. **The argument is unguessable.** `p_token_hash` is a SHA-256 of a 256-bit random token that
   exists only in the invited person's inbox. A caller who can supply a matching hash already holds
   the credential, and all they learn is an opaque organisation id they cannot act on — acceptance
   still requires being authenticated as the invited address. This is the substantive difference
   from `user_organizations(text)`, whose argument is a user id and whose comment therefore has to
   insist it comes from the session and never from a path parameter. That warning does not apply
   here, and the reason is the unguessability of the argument, not a weaker rule.
3. **`search_path = public, pg_temp`, with `pg_temp` last, from the first line.**
   [ADR-0021](ADR-0021-definer-search-path-pins-pg-temp-last.md) had to correct
   `user_organizations` for exactly this hijack. This function is written with the pin rather than
   shipped weak and corrected forward.

**The role is reused, not duplicated, and that widens ADR-0020's scope.** ADR-0020 describes
`sentinel_org_lookup` as a role that "exists only to own it", singular. That sentence stops being
true here. ADR-0020 is immutable and stays as written; this ADR is the record that the role now
owns two functions.

## Alternatives considered

**A second dedicated `BYPASSRLS` role owning this function alone.** Rejected by the operator on
2026-09-03. It is the narrower blast radius per function, and the argument against it is
operational rather than aesthetic: creating a `BYPASSRLS` role requires superuser, so it cannot be
created by a migration, and every deployment would have to provision a second role out of band
before migrations apply — the precondition carry-forward ruling 96 already records as a cost for
`sentinel_app` and ADR-0020 already pays once. Two roles each bypassing RLS for one narrow function
are not meaningfully safer than one role bypassing it for two. **What contains the bypass is the
fixed predicate and the single returned column in each function body, not the number of owners.**

**Putting the organisation id inside the invitation token.** Rejected. It removes the need for any
lookup, and it makes one endpoint's tenant context client-derived — the API would scope a
transaction to an organisation named by a value the caller supplied. It also changes a credential's
shape, which is what ruling 41 settled. The token stays an opaque random secret whose only property
is that the server can recognise it.

**Shipping Task 15 without acceptance.** Rejected. It leaves the feature unusable end to end,
leaves ruling 122's question unanswerable because there is no acceptance path to measure, and makes
the re-invite-a-removed-member test the phase plan explicitly assigns to Task 15 unwritable.

**Relaxing or dropping RLS on `Invitation`.** Not seriously considered, and recorded so nobody
proposes it later. RLS is the backstop under the tenant-scoped Prisma client, not a duplicate of
it, and `Invitation` is tenant-owned.

## Consequences

- `sentinel_org_lookup` now holds `SELECT` on three tables — `Membership`, `Organization`,
  `Invitation` — instead of two. There are still no default privileges, so a table added by a later
  migration stays invisible to this role until somebody grants it deliberately.
- `sentinel_app` gains `EXECUTE` on one more function and is otherwise unchanged. The measurement
  in the Context section stays true after the migration.
- **A third such question will arrive**, and when it does the choice made here should be
  re-examined rather than repeated by reflex. One role owning two narrow lookups is defensible; one
  role owning a growing collection of them drifts toward being a general-purpose RLS bypass with a
  reassuring name. The trigger for revisiting is a function that needs more than a fixed predicate
  and a single returned column.
- Anyone reading `ADR-0020`'s "exists only to own it" will find it contradicted by the database.
  That is the cost of ADR immutability and it is paid deliberately: the index row for ADR-0020 and
  this document are how a reader finds out.
