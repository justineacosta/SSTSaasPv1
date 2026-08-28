# Phase 2 · Task 8 — Registration and email verification · implementer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-28. Written by the orchestrator before dispatch. Plan section: Task 8 in
[`../../../plans/2026-08-24-phase-2-identity.md`](../../../plans/2026-08-24-phase-2-identity.md).
Branch: **`feat/phase-2-task-08`**, cut from `main` at `a39f4b3`. Tasks 6 and 7 are now merged to
`main` and CI is green on them, so this branch stacks on nothing.

**ADR-0019 is already committed as the first commit on this branch.** Read it before you write
anything. It is the decision this task implements, not a document written afterwards.

You are a fresh implementer. The plan calls this task self-contained enough for one, and the
choice is recorded in `progress.md`.

## What you are building

**The first three routes this product has ever published.** Every prior task in Phase 2 ended with
`pnpm check:openapi` reporting **4 routes**, and a dozen sentences across the ledger call that
number the proof that no endpoint shipped. When you are finished it reports **7**, and those
sentences stop applying. That is the one number in this task that cannot be wrong by accident.

```
POST /api/v1/auth/register             -> 200 { status: 'VERIFICATION_REQUIRED' }
POST /api/v1/auth/verify-email         -> 200 { status: 'EMAIL_VERIFIED' }
POST /api/v1/auth/resend-verification  -> 200 { status: 'VERIFICATION_REQUIRED' }
```

All three request and response schemas **already exist** in `packages/contracts/src/auth.ts` —
`registerRequestSchema`, `registerResponseSchema`, `verifyEmailRequestSchema`,
`verifyEmailResponseSchema`, `resendVerificationRequestSchema`, `resendVerificationResponseSchema`.
Task 2 wrote them and left a comment saying Task 8 owns refining them. Do not redesign them without
a reason you write down: `check:openapi` pins whatever you publish.

## Deliverables

1. **`apps/api/src/modules/auth/auth.controller.ts`** — the three routes, registered on
   `AuthModule`, which currently registers no controller.
2. **`registration.service.ts`** and **`email-verification.service.ts`** — the transactional work.
3. **`PlatformAuditEvent`** — the schema model, the migration, the registry entry, the id prefix,
   and the service that writes it. ADR-0019.
4. **An eighth email template** — the "someone tried to register with your address" message. See
   ruling B.
5. **The `emailVerifiedAt` gate** — a reusable guard returning 403 `EMAIL_NOT_VERIFIED`. See
   ruling F, which tells you what it may and may not claim.
6. **A migration** carrying the new table *and* the partial unique index carry-forward ruling 32
   has owed since Task 4. See ruling C.
7. **Unit and integration specs** for all of it, including the byte-comparison enumeration test.
8. **The documents named under _Doc ownership_.**

## The behaviour

Read `security/authentication.md` §6 and §7, `api/authentication.md` §2 and §7, `security/audit.md`
§2 and §4, and `api/conventions.md` §2–§3 before you write anything. Where two disagree, the
`security/` document wins and you say so in your report.

- **All database work in one transaction; the mail send after it commits.** Carry-forward ruling
  44 — a send inside the transaction either holds it open across network I/O to a third party, or
  sends "your account was created" for a creation that then rolls back. Task 5 wrote that as a
  docblock and no test because no endpoint existed to demonstrate it. **You are that endpoint, and
  you set the pattern Tasks 10, 11 and 15 copy.** Prove it: a spec in which the transaction fails
  after the mail would have been queued must observe zero sends.
- **The response is byte-identical whether or not the address already exists.** Same status, same
  body, same headers that vary with anything you control. The plan is explicit that this is a
  byte comparison of the two responses, not an eyeball check. An address that already exists gets
  the eighth template instead of a verification link — that difference is in the mailbox, never on
  the wire.
- **Timing is part of "identical".** The existing-address path does no Argon2 hash today unless you
  make it. Carry-forward ruling 21: `PasswordService.verify` takes a nullable stored hash precisely
  so an absent account still pays the full cost. Registration is the mirror image — the *existing*
  account is the one that can skip work — and `password.timing.spec.ts` is the shape to copy. If you
  conclude a statistical timing assertion is not worth its flake risk here, say so with a
  measurement, not an opinion.
- **Check `User.status` after `consume` returns.** Carry-forward ruling 37: `TokenService.consume`
  asserts nothing about the user it returns, so a `LOCKED` or `SUSPENDED` user's verification token
  still redeems. The FK cascade only clears a *deleted* user's rows, and ruling 9 records that there
  is no RLS behind `VerificationToken`.
- **One refusal code for every bad token.** `TokenInvalidError` / `TOKEN_INVALID` already exists and
  already covers unknown, expired, consumed and superseded alike. Do not add a second code and do
  not let the four cases become distinguishable — that is what turns the endpoint into an oracle.
- **`PasswordBreachedError` already exists.** Carry-forward ruling 26: 422, code `PASSWORD_BREACHED`,
  spec already pins that nothing hex-shaped reaches the message. Do not build a second one. And
  carry-forward ruling 28: the check is off by default and fails open, so a stored password is never
  *known* unbreached.
- **The three routes are `@Public()`, and therefore not CSRF-covered.** Carry-forward ruling 56 —
  `CsrfGuard` skips public routes deliberately, because the expected token derives from an
  `HttpOnly` cookie a page cannot read. This is correct and it must be **stated in a comment on the
  controller**, not left for a reviewer to discover.

## Rulings

Each is the orchestrator's decision, with the cost if it is wrong. Carry-forward ruling 55 applies
to this document: **a brief asserting that a mechanism exists is a claim, and every one below was
checked against the tree before dispatch.** If you find one is false, that is a finding you report,
not a thing you work around.

### Ruling A — registration and verification are audited in `PlatformAuditEvent`, per ADR-0019

The plan says: resolve the non-nullable `AuditEvent.organizationId` deliberately and write down
which you chose, and do not quietly skip the audit. The choice is made and it is ADR-0019: a
separate table for actions that have no organisation.

Verified before the ADR was written, and you may rely on all four:
`AuditEvent.organizationId` is NOT NULL with a `Restrict` FK; the table carries RLS
`USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))` at
`packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql:24-28`; the API's
`PRISMA` token is the **unscoped** client (`apps/api/src/infrastructure/prisma/prisma.module.ts`),
so nothing sets `app.organization_id` on a registration request; and `pnpm check:registry` requires
every model to be exactly one of tenant-owned / tenant-root / deliberately-global.

The ADR also records a measurement taken on 2026-08-28 against the compose Postgres: on a scratch
table carrying that exact policy, as `sentinel_app`, the tenant-scoped insert succeeded and a
`NULL`-organisation insert was refused with `new row violates row-level security policy`. **Re-run
it if you doubt it** — the ADR states it as measured and it is fair game for your report to
contradict.

`PlatformAuditEvent` gets the same tamper resistance as `AuditEvent`: `UPDATE` and `DELETE` revoked
from `sentinel_app`, plus the append-only trigger. The trigger function `audit_event_is_append_only()`
already exists from the Phase 1 migration — reuse it rather than writing a second one. Register the
model as **deliberately global**, add its id prefix to **both** registries (carry-forward ruling 5:
`packages/db/src/id.ts` and `packages/contracts/src/ids.ts` are independent lists, and
`id-prefix-parity.spec.ts` now cross-checks them).

`security/audit.md` §4's action taxonomy has **no name for registration** — I checked the whole
list; `EMAIL_VERIFIED` is there under Auth and a registration action is not. You add one, to the
document and the code, in the same change.

*Cost if wrong:* two audit tables to union forever, and a Phase 3 `/audit-logs` that has to know
about both. The ADR argues that cost is cheaper than rewriting the RLS policy on the most sensitive
table in the product. If you find a fifth constraint that breaks the design, stop and report it
rather than building around it — an ADR is superseded, not patched.

### Ruling B — you own the eighth email template

The plan requires an existing address to receive a "someone tried to register with your address"
message. **That template does not exist.** `apps/api/src/modules/auth/emails/registry.ts` has
exactly seven members — `emailVerification`, `passwordReset`, `invitation`, `passwordChanged`,
`mfaEnabled`, `mfaDisabled`, `newDeviceSignIn` — and carry-forward ruling 43 says in as many words
that the next template added is the eighth and no task owns it. Task 8 owns it now.

It carries **no token and no link**, so it belongs to `NOTICE_TEMPLATE_IDS`, not
`TOKEN_LINK_TEMPLATE_IDS`. The registry's spec partitions those two lists exactly and its sample
table is keyed by `EmailTemplateId`, so adding a member without adding its sample is a compile
error — you inherit every assertion by existing, which is the design ruling 43 describes.

Do not name the recipient's address in the body. The three token-link templates already refuse to,
for the reason written in `token-link.templates.ts`, and this message is sent to an address someone
*else* just typed.

*Cost if wrong:* a template that ships without a text part, or that echoes an attacker-supplied
display name unescaped. Both are what the registry spec exists to catch.

### Ruling C — this task opens a migration, so it owns the partial unique index

Carry-forward ruling 32: a partial unique index on `VerificationToken (userId, purpose) WHERE
consumedAt IS NULL` is owed and not built, and "the next task that opens a migration owns it".
Tasks 6 and 7 opened none. You are opening one for `PlatformAuditEvent`, so it is yours.

Prisma can neither create nor drop a partial index (carry-forward ruling 4), so it is hand-written
SQL in the migration file. `TokenService.issue` already holds
`pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` and supersedes before inserting inside
one transaction, so the index should never fire for that path — **verify that, do not assume it.**
If it can fire, the loser of a race becomes a P2002 that a caller must catch, and that changes
`TokenService`, which is not your file. Report it rather than editing around it.

Two migrations or one is your call, but carry-forward ruling 1 binds: **each migration must leave
the database sound on its own.** The operator reviews the SQL before it is applied — use
`prisma migrate dev --create-only`, and match the house style in
`packages/db/prisma/migrations/`, where the reasoning leads and the first executable statement
comes after it.

*Cost if wrong:* a hand-written index that Prisma later offers to drop, or a migration that leaves
a clone stopping between two files in an unsound state.

### Ruling D — `verify-email` gets its own per-IP rate-limit class

The three per-account rows of `abuse-prevention.md` §1 are already in
`apps/api/src/common/guards/rate-limit.config.ts`, and two of them are yours as they stand:
`registration` (3/hour per IP, fail closed) and `emailVerificationResend` (3/hour per account by
body field `email`, 10/hour per IP, fail closed). Apply those two. They need no change.

**`verify-email` matches neither, and defaulting it is not acceptable.** A route carrying no class
falls to `generalSession` (`rate-limit.guard.ts:249`), which is `failMode: 'open'` with
`perPrincipal: 'authenticated'` as its only scope — unresolvable on an unauthenticated route, and
carry-forward ruling 55 records that **nothing warns when that happens** at the default log level.
So the default is not a weak limit, it is no limit and no signal. Applying
`emailVerificationResend` instead is worse: its `principalSource` is the body field `email`, which
`verifyEmailRequestSchema` does not contain, so the per-account half would resolve nothing on every
request while the per-IP half resolved — the exact silent-miss the config's own docblock was
written about.

Add a class with a **per-IP window only** and `failMode: 'closed'`, and add its row to
`abuse-prevention.md` §1's table in the same change — that table is transcribed into the config and
the transcription is asserted value by value, so the doc and the code move together or the spec
fails. Suggested figure: **30 per hour per IP**. Justify or change it with a written reason; the
threat is not token guessing (256 bits of entropy makes that infeasible — Task 4's
`secret-token.ts` fixes it at 32 bytes) but an unmetered write attempt against the database.

*Cost if wrong:* too tight and a family behind one NAT cannot verify their accounts; too loose and
an unauthenticated endpoint that writes to Postgres has no bound at all.

### Ruling E — the enumeration test is a byte comparison, and it must be able to fail

The plan says byte comparison, so write one. But carry-forward ruling 58 is the trap here: **a spec
whose fixtures all sit on one side of the branch under test cannot fail for the right reason.** Task
7's entire CSRF suite was `@Public()`, which is why it could not see the hole in the guard. Before
you believe your enumeration test, break the property deliberately — return a different status for
the existing address — and watch it go red. Report the failing output, not the passing run.

*Cost if wrong:* a green test asserting nothing, which is this codebase's most frequently recurring
defect: rulings 13, 49, 58, and Phase 1's `.test.ts` files that executed nothing while `pnpm test`
printed green.

### Ruling F — build the `emailVerifiedAt` gate, and state plainly that it gates nothing yet

The plan says: build a reusable guard returning 403 `EMAIL_NOT_VERIFIED`, apply it to organisation
creation in Task 13, and "a gate that exists but is applied nowhere is not a gate; the test must
assert it on a real endpoint."

**Those two sentences cannot both be satisfied in this task, and I am choosing which one gives.**
Task 8's three routes are all `@Public()` and all reachable by someone with no account at all;
there is no real endpoint in existence for the gate to guard. `GET /auth/session` is Task 9's and
organisation creation is Task 13's.

So: build the mechanism, prove it against purpose-built controllers through
`apps/api/src/testing/routing-app.ts` — the harness Task 7 used for exactly this — and **write in
the code and in your report that it governs zero real routes until Task 13.** This is the precedent
Task 7 set with `@AllowPendingMfa()` and Phase 1 set with the rate limiter: a control built
correctly ahead of the endpoints it will govern, described as such, and never described as in
force.

`EMAIL_NOT_VERIFIED` already exists in **both** `packages/contracts/src/error-codes.ts` and
`api/errors.md` §3 — I checked both. You add no code, so carry-forward ruling 27's two-list problem
does not land on you.

Carry-forward ruling 61 binds the guard's own tests: if the exemption or the requirement is
handler-level, **test it at the class level too**, including an inheritance case, because
`getAllAndOverride` walks the prototype chain. This codebase shipped that exact bug once in
`@RateLimitExempt()`.

*Cost if wrong:* Task 13 inherits a guard nobody proved, or — worse — the roadmap records
`EMAIL_NOT_VERIFIED` as enforced when no route carries it.

### Ruling G — the resend path is a deliverable, not a nicety

Carry-forward ruling 45: a failed send is not retried, not queued, and nothing alerts on it, so
the first verification send is otherwise authoritative — and the person locked out by an SMTP blip
has no remedy. `POST /auth/resend-verification` is the remedy and it is in this task's scope.

It is enumeration-resistant on exactly the same terms as registration: same status, same body, for
an address that does not exist, an address that exists and is unverified, and an address that
exists and is already verified. Three cases, one response. `TokenService.issue` already supersedes
the previous live token for the same `(userId, purpose)` under an advisory lock, so a resend
invalidates the earlier link by construction — **verify that is what happens rather than assuming
it**, because it is the property that makes the resend safe.

*Cost if wrong:* three response shapes where there should be one, and an endpoint that tells an
attacker which addresses are registered and which are verified.

## What you are not building

Login, logout, the session endpoint, lockout, password reset, MFA, and the authorization guard.
`@RequirePermission()` is still metadata no guard enforces — Task 12 — so no route of yours may
rely on it. Nothing in `apps/web`: there is no screen for any of this until Task 16, and the link
in the verification email points at `/verify-email`, a route that does not exist yet. That is
expected and it is not yours to fix.

## Doc ownership

Update in this task, per the plan and `CLAUDE.md`'s documentation rule — these ship with the
behaviour, not at the end:

- **`.claude/security/authentication.md` §6** — the verification token row, and the
  unverified-user gating rule as this task actually enforces it (which, per ruling F, is: built,
  proven, and applied to no route yet).
- **`.claude/api/authentication.md`** — the registration and verification endpoints, which the
  committed OpenAPI document now contains.
- **`.claude/security/audit.md`** — §2 and §4 at minimum: the second table, and the registration
  action that the taxonomy currently lacks.
- **`.claude/security/abuse-prevention.md` §1** — the new rate-limit class from ruling D, and the
  status banner's "it limits no endpoint today", which your three routes make false.
- **`.claude/architecture/backend.md`** — if and only if you change the pipeline or the module
  layout it describes. Check it; do not edit it reflexively.

## Verification

Run all of these on the finished tree and report the exit code of each, **captured outside a pipe**
(`out=$(pnpm <cmd> 2>&1); code=$?`) — `$?` after a pipe reports the last stage's status, not the
command's:

```
pnpm format:check · pnpm lint · pnpm typecheck · pnpm test · pnpm check:specs
pnpm test:integration · pnpm build · pnpm check:openapi · pnpm check:registry
pnpm check:secrets · docker compose ps
```

`pnpm check:openapi` must report **7 routes** and the committed `apps/api/openapi.json` must be
regenerated. Carry-forward ruling 40: `pnpm test` and `pnpm lint` can both be green while
`pnpm typecheck` is not — run all three. Carry-forward ruling 39: if you mutate `schema.prisma`,
run `prisma generate` after reverting, because `packages/db/generated/` is untracked and a clean
`git status` is not evidence that a mutation was undone.

Integration tests go against a real Postgres via Testcontainers. Carry-forward ruling 33: the
integration suite runs sequentially and that is load-bearing — do not restore parallelism.

## How you report

**You report commands and exit codes. You do not write status prose.** No "this now works", no
summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative beyond the factual document
updates named above. Phase 1's recurring defect was false factual claims in written prose — twelve
instances, five of them introduced while correcting an earlier one — and the orchestrator writes
every sentence that asserts anything.

Two things that have paid off three times in this phase and are worth more than a clean report:

1. **Disclose any claim that is a reading rather than a measurement.** Rulings 57 and 60 both exist
   because an implementer said "I believe this but I did not measure it", and both turned into
   measurements that closed a real question.
2. **Write your own mutations.** Apply them to the implementation, not to the tests, and report
   which ones the suite killed and which survived. A survivor is a finding whether or not it is a
   bug.

Write the report to `docs/superpowers/ledger/phase-2/task-08/report.md`. A fresh adversarial
reviewer reads it next, and their first pass is citation — every factual claim in it re-verified
against the repository before a line of your diff is opened.
