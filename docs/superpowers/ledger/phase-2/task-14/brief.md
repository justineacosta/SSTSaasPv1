# Task 14 brief — Memberships, roles, and the last-owner invariant

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-03, before any code. Branch
`feat/phase-2-task-14-memberships`, cut from `main` **after Task 13 merged**.

Plan section: [`Task 14`](../../../plans/2026-08-24-phase-2-identity.md) — "Memberships, roles, and
the last-owner invariant". Execution mode: implementer subagent, fresh adversarial reviewer after.
**Task 14 only.** The plan groups 13→15 as a chain; the operator paces one task per session.

## 1. What makes this task different from Task 13

Task 13 was mostly *new* surface. Task 14 is mostly *invariants over existing rows*, and every one
of them is a concurrency question wearing a CRUD endpoint's clothes. Three of the four bullets in
the plan describe a race or a multi-row state, not a handler.

The specific trap this task sits on top of: **`(organizationId, userId)` is unique only
`WHERE "deletedAt" IS NULL`** (carry-forward ruling 99). Task 14's removal path is *what produces*
the multi-row state — remove, re-add, remove again, and one `(org, user)` pair has three rows with
one live. Every `Membership` read you write must carry `deletedAt: null`, and the Task 12 review
already measured what happens otherwise: a `findFirst` with no predicate returned a `REMOVED` row,
which resolves as `not-a-member` — **a silent, non-deterministic 404 on every guarded route for a
member who is active.**

And ruling 100 is the companion: **a regression test for a non-deterministic read has to be arranged
to lose.** The first attempt at ruling 99's test inserted the removed rows *after* the live one and
passed under the mutation, because Postgres seq-scans a small table in physical order and the live
row came back first by luck. Remove-then-re-add puts the live row last. **Measure the guard, not
just the fix.**

## 2. What to build

`apps/api/src/modules/memberships/*`, plus the roles endpoint in the existing
`apps/api/src/modules/roles/`.

| Route | Access declaration | Notes |
|---|---|---|
| `GET /organizations/:id/members` | `@RequirePermission('organization.manage_members')` | Paginated |
| `PATCH /organizations/:id/members/:membershipId` | `@RequirePermission('organization.manage_roles')` | Role change only |
| `DELETE /organizations/:id/members/:membershipId` | `@RequirePermission('organization.manage_members')` | Soft delete |
| `GET /roles` | `@RequirePermission('organization.read')` | Seeded system roles and their permissions |

**The member list's permission contradicts a docblock in the contracts, and the plan wins.**
`memberships.ts`'s `membershipUserSchema` justifies its narrow user projection with the words *"a
member list is readable by anyone with `organization.read`"*. The plan says all three membership
routes require `organization.manage_members`. Implement the **plan** — and correct that sentence in
the same change, per the documentation rule, rather than leaving a shipped file asserting a
permission the API does not use. The reasoning, so you do not re-open it: widening a route from
`manage_members` to `organization.read` later is additive and breaks no client, while narrowing it
is a breaking change to a shipped contract; and the docblock's actual argument — that a colleague's
`lastLoginAt` and `lockedUntil` are not their team's business — is *stronger* under the narrower
permission, not weaker. If you conclude the plan is wrong, report it with the reasoning and stop;
do not silently pick the other one.

**Contracts exist and must not be rewritten.** `packages/contracts/src/memberships.ts` ships
`membershipResponseSchema`, `updateMembershipRequestSchema`, `listMembershipsQuerySchema`,
`membershipCollectionSchema`, `roleResponseSchema` and `roleCollectionSchema`. Read that file first.
Note `updateMembershipRequestSchema` takes **`roleKey` and nothing else** — `status` is deliberately
absent, because removal is a soft delete and the CHECK constraint makes `REMOVED` and soft-deleted
one fact; exposing `status` would invite a client to ask for half of a two-column invariant.

**The path shape is a decision, and it is `:id/members/:membershipId`.** Task 13 established that
`:id` must equal the resolved tenant and anything else is 404 (`assertPathIsActiveTenant`). Reuse
that helper — do not write a second one, and do not resolve the tenant from the path.

## 3. Decisions already taken. Implement these; do not re-litigate them.

**D1 — The last-owner invariant is enforced by locking the organisation row, not by counting
twice.** This is the task's central decision and the plan explicitly refuses the naive form
("that needs a transaction with the right isolation or a constraint, not two independent reads").

Take a row lock on `Organization` at the start of **every** membership write that can change the
owner count — role change and removal both — and count owners *inside* that lock:

```sql
SELECT id FROM "Organization" WHERE id = $1 FOR UPDATE
```

Then count `ACTIVE`, non-deleted memberships holding `OWNER`, and refuse with **422** if the write
would take it to zero.

**Why this shape and not the alternatives**, so you do not re-derive it:

- **A CHECK constraint cannot express it.** "At least one row matching X exists" is not a row-level
  predicate. Postgres has no declarative form.
- **A trigger alone does not fix the race.** Two concurrent transactions each demote a different
  one of the two remaining owners. Each trigger counts under its own snapshot, each sees two
  owners, both commit, and the organisation has none. The snapshot is the problem, not the check.
- **`SERIALIZABLE` would work and is rejected.** It detects the anomaly and aborts one transaction
  with `40001`, which then needs a retry loop — and an unhandled `40001` surfaces as a 500 on a
  routine role change. The lock serialises the same window with no retry and no new failure mode.

The lock is per organisation, held for the length of one short transaction, on a table with one row
per tenant. It is not a throughput concern at any scale this product will see in Phase 2.

**Consider a trigger as a second layer if it is cheap**, on the Task 13 precedent that the database
should hold what the application asserts — but the lock is the mechanism, and a trigger that only
catches the single-transaction case must be documented as exactly that rather than as the fix.

**D2 — Test the race for real, and arrange it to lose.** A test that runs two demotions
sequentially proves nothing. Open two concurrent transactions against real Postgres, have both read
the owner count, then let both attempt their write. Without the lock both succeed and the
organisation ends with zero owners; with it, one waits and then fails 422. **If you cannot make the
unlocked version fail, you have not tested the race** — say so rather than reporting a green test.

**D3 — Removal writes `status` and `deletedAt` together, always.** Carry-forward ruling 10: the
CHECK constraint `Membership_status_deletedAt_agree_check` makes `("deletedAt" IS NULL) = (status <>
'REMOVED')` a database invariant, so a bare `status: 'REMOVED'` is an invalid write and so is a bare
`deletedAt`.

**D4 — Removing a member revokes their sessions for that organisation and must not brick their
account.** Invariant 5, and carry-forward ruling 95 is the limit on it. Reuse
`SessionService.revokeAllForUserInOrganization` (`session.service.ts:739`) — which already exists and
is already tested — and revoke **only** the sessions pointed at that organisation. A session of
theirs pointed at a different organisation, or at none, must survive: a removed member still has to
reach `GET /auth/session`, `POST /auth/logout` and their MFA routes, all `@AuthenticatedOnly()`, or
they hold a valid credential that no endpoint will answer including the one that ends the session.

Test that the removed member's next request to a guarded route is refused **immediately**, not
eventually, and in the same test file prove the account is not bricked.

**D5 — A role change may not grant a role the actor does not themselves hold the permissions for.**
`security/authorization.md` §4's no-minting-authority rule, which the plan states for custom roles
and Task 15's invitations. It binds here for the same reason: an `ADMIN` holds
`organization.manage_roles` but not `organization.delete`, so promoting someone to `OWNER` would
mint authority the actor does not possess. Refuse with **403**, and make the check a comparison of
permission *sets* rather than a hard-coded role ranking — a ranking is a second model of authority
that drifts from `ROLE_PERMISSIONS`.

**D6 — `GET /roles` returns seeded reference data and says custom roles are Phase 11.** Say it in
the OpenAPI description, per the plan, rather than leaving a gap a reader fills in wrongly. The
route declares `organization.read` because every system role holds it and it is read within an
organisation context; it is not `@AuthenticatedOnly()`, because the role picker is a thing you use
*inside* an organisation.

**D7 — Every change writes an audit event in the same transaction, with before/after role in
metadata.** `MEMBER_REMOVED` and `ROLE_CHANGED` are already in `security/audit.md` §4's taxonomy and
must be added to `AUDIT_ACTIONS` — which currently holds **three** names, verified by extracting the
constant rather than reading it. These have an organisation in hand, so they are `AuditEvent` rows,
not `PlatformAuditEvent` (ADR-0019 routes on the presence of an organisation).

Note the Task 13 asymmetry that does *not* apply here: `ORGANIZATION_DELETED` is unwritable because
`AuditEvent` has a `Restrict` foreign key to the row being deleted. A membership soft delete deletes
nothing, so `MEMBER_REMOVED` has no such problem.

## 4. Rulings that bite in this task

Full text in [`../progress.md`](../progress.md). These are the ones that will cost you if you skip
them:

- **99** — `deletedAt: null` on every `Membership` read. This task creates the state that makes it
  matter.
- **100** — arrange the non-determinism test to lose.
- **95** — removal must not brick the account.
- **10** — `status` and `deletedAt` move together.
- **9** — the four user-owned tables have no RLS; a handler taking a `userId` must prove the caller
  is that user.
- **106 / 107** — if you add any database object with elevated privilege, `pg_temp` goes last in
  `search_path`, and a security property asserted in prose is a hypothesis until someone tries to
  violate it. Task 13 shipped two defects in one ADR this way.
- **108** — when a document states a count, **compute** the count. Three parties miscounted in Task
  13 and every catch came from a grep, never from careful reading.
- **109 / 110** — a test arm can record itself as exercised while never reaching the code it names,
  and guards run before validation so any check inside a handler sits behind the request body. Both
  bite the authorization matrix, which you will be extending.
- **14** — `UNKNOWN_FIELD` at 400 only when every Zod issue is an unrecognised key.

## 5. Testing — where this can actually fail

- **Cross-tenant isolation is mandatory** and the answer is **404, not 403**, on all three
  membership routes: another tenant's `membershipId`, and a `membershipId` that does not exist.
- **The authorization matrix must cover the new routes.** It now runs over real guarded routes.
  Note `bodyFor()` — Task 13 added it because arm 3 was answering 400 from the validation pipe
  before reaching the handler. `PATCH /organizations/:id/members/:membershipId` will need an entry;
  arm 3 fails loudly and names the registry if you forget.
- **The soft-delete round trip**: add, remove, re-add, and assert the resolver returns the **live**
  row — arranged so the live row is physically last (ruling 100).
- **The race test** (D2), against real Postgres, which cannot be a unit test.
- **Session revocation is immediate**, and the account is not bricked (D4). Both directions.
- **Mutation-test every security claim.** For each "X is refused", run the mutation, watch it go
  red, paste the counts, and **list survivors** (ruling 97). A test you did not try to break has
  proven nothing — Task 13's review found an arm that had never reached the code it was named
  after.

## 6. Documentation you own

Per execution protocol §6, in the same task:

- `.claude/api/authorization.md` and `.claude/security/authorization.md` — the guarded route set
  grows; §4's no-minting-authority rule now has a second enforcement point (D5).
- `.claude/security/audit.md` — `MEMBER_REMOVED` and `ROLE_CHANGED` gain producers. **The document
  states a count of `AuditEvent` names; recompute it, do not adjust it by hand.**
- `.claude/product/permissions.md` — invariant 1 (always an owner) and invariant 5 (removal revokes
  sessions) become enforced rather than described. Say which mechanism enforces each.
- `.claude/architecture/backend.md` — its pipeline table has per-row status claims that Task 13
  found stale in four places. Check whether this task falsifies any.
- **You do not write status prose.** No `roadmap.md` edits, no "this now works". Report commands and
  exit codes; the orchestrator writes every sentence that asserts anything.

## 7. Verification

Run all of these, capturing the **real exit code outside a pipe** —
`out=$(pnpm <cmd> 2>&1); code=$?`:

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`, `docker compose ps`.

**Baselines at the merge commit** — re-measure them yourself before you start, do not trust this
table. Measured by the orchestrator on 2026-09-03, on this branch, at the tip you start from:
`pnpm test` 95 files / **1628** tests; `check:specs` **120** spec files; `test:integration` 25 files
/ **443** tests; `check:openapi` **21 paths** (the command logs *paths* — it does not print an
operation count, and a brief that told you otherwise would be wrong; Task 13's did);
`check:registry` **15** models; `check:secrets` **434** tracked files.

**Two of those numbers were wrong in the first draft of this brief. One correction was right and
one was itself false, and the false one is left standing here with its refutation** rather than
quietly rewritten, because that is the pattern this phase keeps producing.

- *Right:* it said 440 integration tests where the command prints **443**.
- *Wrong:* it said `main` was 433 tracked files "and the difference is this file". Both halves are
  false. `scripts/check-secret-shaped-literals.ts:167` excludes `^docs/superpowers/` by path, so no
  ledger file can move that count at all; and `origin/main` computes to **434**, not 433. Measured
  after the fact with the script's own filters over `git ls-tree -r --name-only`: `origin/main`
  434, this branch's base 434. The 433 came from an older commit's dated evidence in `roadmap.md`,
  and the orchestrator invented a cause for a number it had not traced. **Found by the implementer,
  not by the author** — ruling 108 landing on the correction that cites ruling 108.

`check:registry` must still report **15 models** — this task adds no table. A change there means you
added a model you did not mean to.

**Migrations**: `prisma migrate dev --create-only`, then stop and report the SQL. The operator reads
every migration before it is applied. **Never run `pnpm db:reset`** — Prisma refuses it for an agent
and demands a consent string you must never fabricate (ruling 3). If you add a trigger for D1, lead
with the reasoning and then the SQL, house style.

**Known flake, not yours**: `auth.mfa.integration.spec.ts` has a TOTP step-boundary race outside
this range. If it fails once and passes on re-run, say so; do not chase it and do not report it as
a Task 14 regression.

## 8. What to report

Commands, exit codes, file paths, measurements. For each security claim, the mutation and what it
did. For D1 and D2, the transcript of the concurrent-transaction test — both the failing unlocked
version and the passing locked one, because the first is what proves the second means anything.

**If something in this brief is wrong, say so with the measurement that shows it, and stop rather
than routing around it.** Task 13's brief was wrong in three places and the implementer caught all
three; that is the outcome this instruction is for, not an unusual one.
