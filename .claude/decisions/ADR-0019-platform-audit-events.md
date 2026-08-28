# ADR-0019: Actions with no organisation are audited in a separate `PlatformAuditEvent` table

**Status:** Accepted · **Date:** 2026-08-28

## Context

`CLAUDE.md`'s tenth critical rule says every security-relevant action writes an audit event in
the same transaction as the change. Phase 2 Task 8 ships the first two actions in this product
that are security-relevant and have **no organisation**: a user registering, and a user
verifying their email address. Both happen before the account belongs to anything.

`AuditEvent` cannot hold them, and the obstruction is not only the column type:

- `AuditEvent.organizationId` is `String` (NOT NULL) with a `Restrict` foreign key to
  `Organization` (`packages/db/prisma/schema.prisma`). There is no id to put there that is not
  a fabrication.
- The table carries row-level security —
  `USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`, from
  `packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql:24-28`. So
  relaxing the column to nullable does not make the write work. **Measured** against the compose
  Postgres on 2026-08-28, as `sentinel_app` with `app.organization_id` set, on a scratch table
  carrying that exact policy: the tenant-scoped insert succeeded, and the `NULL` insert was
  refused with `new row violates row-level security policy`. A nullable column would need the
  policy rewritten as well, and the rewrite is the actual decision.
- `security/audit.md` §6 is a promise about that table: tenants read their own log, and "no API
  exposes another tenant's events". Rows belonging to nobody sitting inside the table every
  tenant reads is a question every future query has to answer correctly, forever, by remembering.
- `pnpm check:registry` requires each model to be accounted for by **exactly one** of
  tenant-owned, tenant-root, or deliberately-global (currently 3 / 1 / 10 across 14 models). A
  table that is tenant-owned for most rows and global for some has no honest entry.

`TokenService`'s docblock has recorded this gap since Task 4 and pushed it to the endpoint tasks;
Task 8 is the first of them, so the deferral ends here.

## Decision

A second table, **`PlatformAuditEvent`**, holds security-relevant actions that have no
organisation. It carries the same fields as `AuditEvent` minus `organizationId`, and the same
tamper resistance: `UPDATE` and `DELETE` revoked from `sentinel_app`, plus the append-only
trigger that already exists as `audit_event_is_append_only()`.

It is registered as **deliberately global** in the tenant resource registry — which is what it
is: a row about a person, written before any tenant exists, that no tenant may read.

`AuditEvent` is unchanged. Its column stays NOT NULL, its policy stays as written, and every
query already pointed at it keeps its current meaning.

The routing rule is the presence of an organisation, not the kind of action: `EMAIL_VERIFIED`
for a user who belongs to no organisation is a platform event, and the same action for a member
acting inside one is a tenant event. Task 8 writes only platform events because registration and
verification never have an organisation in hand.

## Alternatives considered

**Make `AuditEvent.organizationId` nullable and rewrite the RLS policy.** One table, one query
surface, and the cross-cutting read stays a single `SELECT`. It loses on the blast radius: the
policy that protects the most sensitive table in the product would be rewritten to admit a new
row shape, and every read of that table — including `/audit-logs`, which Phase 3 has not built
yet — would silently include or exclude the null rows depending on how the new `USING` clause
happened to be written. The measurement above is the concrete form of that risk: the current
policy's behaviour on `NULL` is *refusal*, so nothing about the change is a no-op.

**Do not audit registration or verification.** Honest about the constraint, and cheap. Rejected
because it makes `CLAUDE.md` rule 10 false at exactly the point where the audit trail matters
most — account creation is the first event in every account-takeover investigation — and the
Phase 2 plan names this as the thing not to do quietly.

**Write the event against a synthetic "platform" `Organization` row.** Keeps one table with no
schema change. Rejected: a fabricated foreign key that every tenant-scoped query must learn to
exclude, and a row in `Organization` that is not an organisation. It converts a schema problem
into a data problem, which is harder to notice and harder to reverse.

**Defer the whole question to Phase 3, when `/audit-logs` is built.** Rejected: the events are
being generated now. Deciding later means either not recording them or recording them somewhere
temporary, and both cost more than deciding now.

## Consequences

**Positive.** `AuditEvent` and its policy are untouched, so no existing guarantee is renegotiated.
The registry stays a clean trichotomy. A tenant cannot read a platform event by construction
rather than by a `WHERE` clause anyone could forget. The append-only guarantee is reused, not
reimplemented — the trigger function already exists.

**Negative, and this is the real cost.** There are now two audit tables. The platform-admin
cross-tenant view that `audit.md` §6 describes will have to read both and merge them, and any
future "everything that happened to this user" query is a union. That cost is paid by a reader
that does not exist yet; the alternative charged its cost to a table that already has readers.

**Negative.** `security/audit.md` §3's event shape and §4's action taxonomy now describe two
tables rather than one, and §4 currently has no action name for registration at all — Task 8
adds one, and the document is updated in the same change.

**Neutral.** Retention (§7) will need to cover both tables. Neither is implemented yet.

**Reversible at a known price.** If the union turns out to be the wrong trade in Phase 3, merging
`PlatformAuditEvent` into a nullable-column `AuditEvent` is a data migration plus the policy
rewrite this ADR declined — that is, exactly the rejected alternative, done later with the same
work and a table of real rows to move. Superseding ADR, not an edit.
