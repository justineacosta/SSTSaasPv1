# Phase 2 · Task 1 — brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-24. Written by the orchestrator before dispatch.

**Task:** Identity schema, migrations, registry, and the `Membership` partial-unique fix.
**Plan section:** `docs/superpowers/plans/2026-08-24-phase-2-identity.md`, "Task 1".
**Mode:** fresh implementer subagent + separate adversarial reviewer (plan, Execution protocol §2 —
Task 1 is in the self-contained row).
**Branch:** `feat/phase-2-identity`. Nothing is pushed.

## Orchestrator rulings taken before dispatch

Both are places where the plan's text does not match what is in the repository. Recorded here with
the cost if the ruling is wrong, per the phase's ledger convention.

### Ruling 1 — two migrations, two commits, not one

The plan's first checklist item says the `Membership` fix lands **"first, in its own commit"**; its
last item says the rename and the partial index are "both hand-written into **the generated file**",
singular. Those cannot both hold. Ruling: **two migrations and two commits** — migration A is the
partial unique index alone, migration B is the identity expansion including the
`Session.expiresAt` → `idleExpiresAt` rename.

*Why:* the plan requires the re-invite test to **fail before the migration and pass after**. That is
only a real observation if the partial-index migration is the only thing that changed between the two
runs.

*Cost if wrong:* one extra migration directory. Both apply in order to a fresh database, neither
loses data, and collapsing them later is a rewrite of unapplied history at worst.

### Ruling 2 — the grants are already there; add the assertion, not a GRANT

The plan says to "extend the row-level-security migration's grant block". Verified against the
repository, that block does not exist and the migration must not be edited anyway:

- `packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql` contains **no
  `GRANT`**. Its only privilege statement is `REVOKE UPDATE, DELETE ON "AuditEvent" FROM sentinel_app`.
- Grants live in `infra/docker/postgres/init/01-app-role.sql`, which ends with
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
  sentinel_app`. Tables created afterwards by the owner — `sentinel`, the role in
  `DIRECT_DATABASE_URL`, which is what runs migrations — inherit those grants with no further
  statement.
- Editing an applied migration changes its checksum. **See the correction below — this sentence names the wrong command.**

Ruling: **write no new `GRANT`.** Do exactly the half of that bullet that is real — assert in an
integration test that `sentinel_app` actually holds `SELECT`, `INSERT`, `UPDATE`, `DELETE` on every
table this task creates, via `has_table_privilege`.

*Cost if wrong:* the assertion fails red on a table the default privileges did not reach, and an
explicit `GRANT` goes into migration B. It fails in the safe direction — a missing grant surfaces as
a test failure here rather than as a confusing runtime permission error later, which is what the
plan's bullet wanted in the first place.

## Hard gate: the operator reviews every migration as SQL before it is applied

Execution protocol §5. The implementer generates with `--create-only`, hand-writes the statements
Prisma gets wrong, and **stops**. It does not run `pnpm db:migrate`. The orchestrator brings the SQL
to the operator; only after that does the implementer apply it.

Two statements Prisma will get wrong, both named in the plan:

| Statement | What Prisma emits | What must be written |
|---|---|---|
| Partial unique index | nothing — the schema language cannot express it | `DROP INDEX "Membership_organizationId_userId_key"; CREATE UNIQUE INDEX ... WHERE "deletedAt" IS NULL` |
| `Session.expiresAt` → `idleExpiresAt` | `DROP COLUMN` + `ADD COLUMN` — data loss wearing a rename's name | `ALTER TABLE "Session" RENAME COLUMN "expiresAt" TO "idleExpiresAt"` |

House style for the file: lead with the reasoning, then the SQL. The four Phase 1 migrations do this —
in `20260820142200_membership_user_restrict/migration.sql` the first executable statement is on
line 21.

## Verification owed

`pnpm db:migrate` applies · `prisma migrate deploy` against a fresh empty database applies all
migrations · `pnpm check:registry` exits 0 · the re-invite test fails before migration A and passes
after · `pnpm test` and `pnpm test:integration` green · `pnpm lint`, `pnpm typecheck`,
`pnpm format:check` green.

## Operator ruling at the migration-A gate — 2026-08-24

Migration A approved as written, index name unchanged, **plus a follow-up**: the drift hazard is to
be guarded by CI rather than by a comment. Prisma cannot see the partial unique index, so every
future `prisma migrate dev` — for the remaining seventeen tasks of this phase — will offer to drop
it and re-add the full `@@unique`. Today the only defence is a comment in `schema.prisma` and a
comment in the migration, both of which depend on somebody reading them at the moment they are
tired.

The follow-up is **not built inside Task 1** — it is out of this task's scope and would be an
unreviewed CI change smuggled into a schema commit. It is recorded as an outstanding item and
carried forward to every later task in this phase.

*Shape it should take, for whoever picks it up:* a check that fails the build when the full unique
index is present or the partial one is absent — `prisma migrate diff --exit-code` is the obvious
candidate, though it may need a probe against a migrated database instead, since the drift being
detected is precisely the difference between `schema.prisma` and the applied SQL that this design
creates on purpose. The regression test
`packages/db/src/membership-soft-delete.integration.spec.ts` already catches the behaviour; what is
missing is a check that catches it in the cheap CI lane, before a migration is applied.

## Correction to Ruling 2 — 2026-08-25, after the adversarial review

**The orchestrator wrote the wrong command, and it propagated.** Ruling 2 above said that editing an
applied migration "fails the next `migrate deploy`". Measured by the reviewer against Prisma 6.19.3:
`migrate deploy` does **not** verify checksums and exits 0 on a drifted history. `prisma migrate dev`
is what refuses, demanding a reset. `prisma migrate status` does not detect it either, so it is not a
safe way to check whether history has been edited.

What this changes: CI, Testcontainers and any fresh clone were never at risk — they replay from empty
through `migrate deploy`. The breakage is **local and developer-facing**, on every `pnpm db:migrate`
until the database is reset. Worse for developers than stated, better for production.

The claim was copied from this brief into a code comment in
`packages/db/src/migration.integration.spec.ts` before it was caught, which is the argument for the
citation pass existing at all: a wrong sentence in a brief becomes a wrong sentence in the
repository within one task.
