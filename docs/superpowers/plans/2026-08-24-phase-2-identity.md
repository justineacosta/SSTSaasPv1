# Phase 2 — Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Invoke `sentinel-verify` before writing "complete" anywhere.

**Goal:** Turn an API with no authentication into one where a real person registers, verifies their
email, logs in with a password and a TOTP code, creates an organisation, invites a colleague, switches
between organisations, manages their own sessions, and where **every** endpoint's authorization is
enforced server-side and proven by a generated matrix test.

**Architecture:** New NestJS modules under `apps/api/src/modules/` — `auth`, `users`, `organizations`,
`memberships`, `invitations`, `roles` — plus two new pipeline stages in `common/` (authentication and
authorization guards) that Phase 1 deliberately left as empty slots. Identity tables extend the Phase 1
Prisma schema. `apps/web` gains the `(auth)` route group's real screens and the `(app)` shell's
org switcher and `/settings/security`.

**Spec sources — these are the contract, this plan is only their sequencing:**
[`.claude/security/authentication.md`](../../../.claude/security/authentication.md) ·
[`.claude/security/authorization.md`](../../../.claude/security/authorization.md) ·
[`.claude/api/authentication.md`](../../../.claude/api/authentication.md) ·
[`.claude/product/permissions.md`](../../../.claude/product/permissions.md) ·
[ADR-0005](../../../.claude/decisions/ADR-0005-authentication-model.md) ·
[ADR-0006](../../../.claude/decisions/ADR-0006-multi-tenant-isolation.md)

**Exit criteria (from `roadmap.md`, verbatim):** the full authentication journey passes E2E; the
authorization matrix test passes for every existing endpoint; sessions revoke immediately.

---

## Global Constraints

Everything in the Phase 1 plan's Global Constraints section still applies unchanged — ESM, Node 26,
`strict` TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, no `any` without
a written justification, Zod at every boundary, `process.env` only inside `packages/config`, no
`console.log`, no raw hex in components, files under ~300 lines, conventional commits ending with
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

Phase 2 adds these, and each one is a review-blocking rule:

- **Branch:** all work lands on `feat/phase-2-identity`. Nothing is pushed without asking the user.
- **No raw secret is stored.** Passwords → Argon2id. Session tokens, pending-MFA tokens, verification
  tokens, reset tokens, invitation tokens, recovery codes → SHA-256 hashed at rest (Argon2id for
  recovery codes, which are human-typed and low-entropy relative to a 256-bit token). TOTP secrets →
  encrypted, not hashed, because they must be recoverable to verify a code.
- **Nothing in this phase is logged that could authenticate anybody.** No token, no code, no password,
  no cookie, no `Authorization` header. The redacting logger from `packages/observability` is the only
  logger.
- **Every mutation writes an `AuditEvent` in the same transaction as the change.** Not after. Not
  best-effort. The transaction is the control.
- **Enumeration resistance is a test, not an intention.** Registration, login, and password reset must
  return responses indistinguishable between existing and non-existing accounts — same status, same
  body, same shape. Timing equality is asserted statistically, not by eye.
- **Cross-tenant access returns 404, never 403.** 403 is only for a resource in *your own*
  organisation that your role does not permit.
- **Every new route declares `@Public()`, `@AuthenticatedOnly()`, or `@RequirePermission()`.** The
  Phase 1 boot assertion already crashes startup otherwise; Phase 2 adds the third declaration kind
  and must extend that assertion, not weaken it.
- **`@RequirePermission()` stops being decoration in Task 12.** Until that task lands, no route may
  rely on it for protection.

### Decisions taken before writing this plan

| Decision | Choice | Recorded in |
|---|---|---|
| Argon2 implementation | `@node-rs/argon2` — prebuilt Rust/napi binaries, no node-gyp on Windows or CI, standard PHC output | ADR-0014 (Task 3) |
| Password breach check | Real HIBP k-anonymity client, behind an env flag, **off in test/CI**, **fails open** on outage | ADR-0015 (Task 3) |
| Email delivery | One mailer port, SMTP adapter against Mailpit now; the Resend adapter is additive and deferred until a production deploy exists | ADR-0016 (Task 5) |
| Web↔API credentialed requests | Explicit CORS allowlist of `WEB_BASE_URL` with `credentials: true`, not a Next-side API proxy | ADR-0017 (Task 7) |
| Pending MFA session | A `Session` row in `PENDING_MFA` status, not a separate Redis-only credential — reuses revocation and makes "rotate on privilege change" literal | ADR-0018 (Task 11) |
| Full journey UI in scope | Yes — the exit criterion says E2E, and there is no E2E without screens | this plan, Tasks 16–17 |

---

## Execution protocol

Decided by the operator on 2026-08-24, before Task 1. This section is binding on every task and
every subagent below.

### 1. One session per task

Each task starts a **new Claude Code session**. That session invokes `sentinel-phase`, reads this
plan's section for its task, reads the previous task's ledger entry, and verifies **the previous
task only** — not the whole phase. Phase 1's exit criteria were re-proven at `40852c1` on
2026-08-24 and recorded in `roadmap.md`; that does not need repeating per task.

A new session per task is not overhead, it is the test. If a fresh session cannot pick up Task N
from the committed record, that is a documentation defect found in five minutes instead of in
Phase 7.

### 2. Execution mode varies by task shape

Phase 1's tasks were mostly independent greenfield packages, which is the ideal shape for a
cold-start implementer. **Phase 2 is a chain**: sessions → auth guard → login → MFA →
authorization guard each inherit shapes and conventions from the one before, and a cold
implementer does not inherit conventions, it re-invents them.

| Shape | Tasks | Mode |
|---|---|---|
| **Self-contained** — clear contract, testable in isolation | 1, 3, 4, 5, 11 | Fresh implementer subagent + separate adversarial reviewer, exactly as Phase 1 |
| **Chained** — shared shapes and conventions | 6→7, 9→10, 13→14→15, 16→17 | One implementer across the whole run; reviewer still fresh per task |
| **Gate** — the phase's own correctness | 12, 18 | Orchestrator does these directly with the operator. Task 12 is where the security model becomes real; Task 18 is where a status gets written |

Tasks 2 and 8 are self-contained enough for a fresh implementer but feed directly into a chain;
either mode is acceptable, and the choice is recorded in the ledger.

**The adversarial reviewer is always fresh, for every task, in every mode.** That part of Phase 1
worked and does not change.

### 3. Who writes prose

Phase 1's recurring defect was not bad code. It was **false factual claims in written prose — 12
instances on that branch, 5 of them introduced while correcting an earlier one**, and the
roadmap's own conclusion was "the commands were never the problem; the sentences written about
them were". Two rules follow, and they are review-blocking:

- **Implementers report commands and exit codes. They do not write status prose.** No "this now
  works", no summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative. Raw evidence
  goes up; the orchestrator writes every sentence that asserts anything.
- **The reviewer's first pass is citation, not code.** Before opening a diff, re-verify every
  factual claim in the implementer's report against the actual repository — run the command, open
  the file, `git show` the range. Only then review the code. Phase 1's reviewers found code
  defects reliably; nobody was assigned the sentences.

### 4. The ledger is committed, in full

`docs/superpowers/ledger/phase-2/` is **tracked in git**, unlike Phase 1's, which lives in
`.superpowers/` (excluded at `.gitignore:81`) and therefore exists only on the machine that built
it — every ruling and review finding from 16 tasks, one disk failure from gone.

One entry per task: the brief, the implementer's report, the review findings, every ruling with
its cost if wrong, and the fix rounds. `progress.md` is the index and ends with the current pause
state.

**The known hazard, stated because committing the full ledger is what creates it.** This is a
large volume of agent-written prose in the repository, and agent-written prose is exactly the
material that carried Phase 1's twelve false claims. A committed ledger must therefore never be
read as a description of current state. Two guards:

- Every ledger file opens with: *"A dated record of what was said and decided at the time. Not a
  description of current state — `roadmap.md` is the only authority on that."*
- **`roadmap.md` remains the single source of truth for status.** A ledger entry never moves a
  status and is never cited as evidence that something works. Only `sentinel-verify`'s captured
  command output does that.

### 5. Migrations are reviewed as SQL before they are applied

The operator reviews every migration's SQL before it touches a database. The mechanism is
`prisma migrate dev --create-only`, which writes the file and stops.

```
pnpm --filter @sentinel/db exec prisma migrate dev --create-only --name <name>
#   -> operator reads packages/db/prisma/migrations/<ts>_<name>/migration.sql
#   -> hand-edits land here, then:
pnpm db:migrate
```

This is not ceremony. **Prisma cannot detect a column rename**: for `Session.expiresAt` →
`idleExpiresAt` it generates `DROP COLUMN` + `ADD COLUMN`, which is data loss wearing a rename's
name. The correct statement is `ALTER TABLE "Session" RENAME COLUMN`, and it has to be written by
hand. Harmless today because no session rows exist — which is precisely why the habit has to form
now, while being wrong is free. The partial unique index in Task 1 is the same story: Prisma's
schema language cannot express it at all.

Match the house style already in `packages/db/prisma/migrations/`: the Phase 1 migrations lead
with the reasoning and then the SQL — in
`20260820142200_membership_user_restrict/migration.sql` the first executable statement is on
**line 21**, after 20 lines of comment explaining why the cascade became `RESTRICT`.

### 6. Documentation ships with the behaviour, not at the end

A `.claude/` document is updated in the **same task** that makes its current text false, per
`CLAUDE.md`'s documentation rule. Task 18 is the phase gate, not a documentation backlog. Each
task below names the documents it owns.

### 7. Checkpoint after Task 12

Tasks 1–12 are a milestone in their own right: **the identity API enforced end to end, with no
UI**. At that point authentication, CSRF, tenant resolution and the authorization matrix are all
live and provable, and nothing in `apps/web` has been touched.

Stop there. Run `sentinel-verify`, write the evidence table, and record the checkpoint in
`roadmap.md` as **Partially Implemented** with the gap named ("identity API enforced; no
authentication UI, so the E2E journey criterion is unmet"). Then Tasks 13–18 continue against a
recorded state rather than against 18 tasks of accumulated assumption.

---
## Task Order and Rationale

The order is a thin vertical slice thickened layer by layer, exactly as Phase 1 was built, so CI is
green at every commit and no task depends on a later one.

Data first (1–2), because every service below needs the tables and the shared Zod shapes. Then the
three primitives that are pure functions of their inputs and testable with no HTTP and no database —
hashing (3), token discipline (4), mail (5). Then session mechanics (6) and the guards that consume
them (7), which is the point where the request pipeline finally has an authenticated principal in it.
Endpoints follow in the order a real user meets them: register and verify (8), log in and out (9),
reset a forgotten password (10), enrol and challenge MFA (11). Authorization (12) lands *before* the
first tenant-owned endpoints (13–15) so those endpoints are never briefly unguarded. The web app
follows the API it calls (16–17). The phase closes by proving it (18).

| # | Task | Depends on |
|---|---|---|
| 1 | Identity schema, migrations, registry, and the Membership partial-unique fix | — |
| 2 | `packages/contracts` — identity contracts, Principal, TenantContext | 1 |
| 3 | Password hashing and the breach check | 2 |
| 4 | Single-use secret tokens | 2 |
| 5 | Mail infrastructure and templates | 2 |
| 6 | Session service — issue, rotate, revoke, cache | 1, 2, 4 |
| 7 | Authentication guard, `Principal`, CSRF, CORS | 6 |
| 8 | Registration and email verification | 3, 4, 5, 7 |
| 9 | Login, logout, session endpoint, lockout | 3, 6, 7 |
| 10 | Password reset | 3, 4, 5, 9 |
| 11 | TOTP MFA and recovery codes | 9 |
| 12 | Tenant resolution and the authorization guard | 7, 9 |
| **A** | **Checkpoint — verify, push, get CI green, record a status in `roadmap.md`** | **1–12** |
| 13 | Organisations and organisation switching | 12 |
| 14 | Memberships, roles, and the last-owner invariant | 13 |
| 15 | Invitations | 5, 14 |
| 16 | `apps/web` — the authentication screens | 8–11 |
| 17 | `apps/web` — app shell, org switcher, `/settings/security` | 13–15, 16 |
| 18 | E2E journey suite, matrix test in CI, ADRs, docs, roadmap | all |

---

## Task 1: Identity schema, migrations, registry, and the Membership partial-unique fix

**Files:** `packages/db/prisma/schema.prisma`, a new migration directory,
`packages/db/src/tenant-resources.ts`, `packages/db/src/id.ts`, `packages/db/src/*.integration.spec.ts`

- [ ] **Fix the known Phase 1 defect first, in its own commit.** `Membership.@@unique([organizationId, userId])`
      is a full unique index over a soft-deleting table, so removing a member and re-inviting them raises
      a duplicate-key error. Replace it with a **partial** unique index —
      `CREATE UNIQUE INDEX ... ON "Membership"("organizationId", "userId") WHERE "deletedAt" IS NULL`.
      Prisma's schema language cannot express this, so: drop the `@@unique` from the model, add the index
      by hand in the migration SQL, and neutralise the resulting drift with a note in the schema explaining
      why `prisma migrate dev` will want to re-add it. **Write the failing integration test first** —
      remove a member, re-invite the same (org, user) pair, assert it succeeds. It must fail before the
      migration and pass after.
- [ ] Fix `packages/db/src/id.ts`'s docstring example, the other Phase 1 residual:
      `org_01J8XK2P9V3QWERTYUIOPASDF` has a 25-character body and contains `U`, `I` and `O`, all excluded
      from the Crockford alphabet the file defines, so `parseIdPrefix()` returns `undefined` for it.
      Replace it with a generated ID and add a test asserting **the docstring's own example parses** —
      otherwise this recurs.
- [ ] Add to `User`: `lastLoginAt DateTime?`, `failedLoginCount Int @default(0)`,
      `lockedUntil DateTime?`. Account lock is per-user and additional to the Redis rate limiter — the
      limiter bounds rate, the lock bounds total attempts.
- [ ] Add to `Organization`: `requireMfa Boolean @default(false)`, `enforcedEmailDomain String?`.
      Both are read by guards in Task 12; `enforcedEmailDomain` is the Phase 11 SSO hook that
      `authentication.md` §8 says must exist from Phase 2.
- [ ] Extend `Session` for the model in `authentication.md` §3: `status SessionStatus` (`PENDING_MFA` |
      `ACTIVE`), `lastSeenAt DateTime`, `absoluteExpiresAt DateTime`, `mfaCompletedAt DateTime?`,
      `rememberMe Boolean @default(false)`, `rotatedFromId String?`. Keep `expiresAt` as the **idle**
      expiry and rename it `idleExpiresAt` in the same migration so the two lifetimes cannot be
      confused — a single `expiresAt` field serving both is exactly how one of them silently stops
      being enforced.
- [ ] New model `MfaFactor`: `id`, `userId`, `type MfaFactorType` (`TOTP`, `WEBAUTHN`),
      `secretEncrypted String`, `confirmedAt DateTime?`, `label String?`, `lastUsedAt DateTime?`,
      `createdAt`. `@@unique([userId, type])` for now. **Multi-row and typed from the start** —
      `authentication.md` §5 requires that WebAuthn be additive rather than a migration of the auth model.
      A factor with `confirmedAt = NULL` has never proven a code and does not count as enrolled.
- [ ] New model `RecoveryCode`: `id`, `userId`, `codeHash`, `usedAt DateTime?`, `createdAt`.
      Ten per user, single-use, regenerable — regeneration deletes the whole set and issues ten new.
- [ ] New model `VerificationToken`: `id`, `userId`, `purpose VerificationPurpose`
      (`EMAIL_VERIFICATION`, `PASSWORD_RESET`), `tokenHash String @unique`, `expiresAt`,
      `consumedAt DateTime?`, `createdAt`. One table, two purposes, because §6 says all three token
      types share one discipline and `Invitation` already carries its own (it is tenant-owned; these are
      not).
- [ ] New model `IdentityProviderLink`: `userId`, `providerId`, `externalId`,
      `@@unique([providerId, externalId])`, `@@unique([userId, providerId])`. **No code reads this in
      Phase 2.** It exists because `authentication.md` §8 and ADR-0005 both say re-modelling identity
      later is the most expensive migration an enterprise SaaS can face, and a table costs nothing now.
      Say so in a schema comment so a future reader does not delete it as dead.
- [ ] **Every new model is user-owned, not tenant-owned** — they hang off `User`, which is global. None
      of them gets an `organizationId`, and none goes in `TENANT_OWNED_MODELS`. Register each in the
      **deliberately-global** list in `tenant-resources.ts` with a one-line reason, or `pnpm check:registry`
      fails — which is the check working.
- [ ] Every `User` relation added here is `onDelete: Cascade` **except** where a cascade would cross a
      tenant boundary. Re-read the `Membership.userId` comment in `schema.prisma` before choosing: a
      referential-integrity cascade runs below both RLS and the tenant-scoped client. These new tables
      are all single-user-owned, so `Cascade` is correct for them — state that explicitly in the
      migration, do not leave it to inference.
- [ ] RLS: these tables are not tenant-scoped, so they get no RLS policy — but `sentinel_app` must hold
      the right grants on them. Extend the row-level-security migration's grant block and assert the
      grants in an integration test, because a missing `GRANT` surfaces at runtime as a confusing
      permission error rather than at migration time.

- [ ] **The migration is generated with `--create-only` and reviewed as SQL by the operator before it
      touches any database** (Execution protocol §5). Two statements in this task are ones Prisma gets
      wrong or cannot express, and both must be hand-written into the generated file: the
      `Session.expiresAt` → `idleExpiresAt` rename, which Prisma emits as `DROP COLUMN` + `ADD COLUMN`
      and which must become `ALTER TABLE "Session" RENAME COLUMN`; and the partial unique index, which
      Prisma's schema language cannot express at all. Lead the file with the reasoning, as the four
      Phase 1 migrations do.

**Doc ownership:** none — this task changes no documented behaviour. The `KNOWN ISSUE` comment on
`Membership` in `schema.prisma` is removed by the fix it describes, and `roadmap.md`'s "Where Phase 2
starts" note that the residual is owed to Task 1 is updated to say it landed.

**Verify:** `pnpm db:migrate` applies; `prisma migrate deploy` against a **fresh empty database** applies
all migrations; `pnpm check:registry` exits 0 and reports the new model counts; the re-invite integration
test passes; `pnpm test:integration` green.

---

## Task 2: `packages/contracts` — identity contracts, `Principal`, `TenantContext`

**Files:** `packages/contracts/src/auth.ts`, `principal.ts`, `organizations.ts`, `memberships.ts`,
`invitations.ts`, `index.ts`, and a spec per file

- [ ] Zod request/response schemas for every endpoint in `api/authentication.md` §2 plus the
      organisation, membership and invitation endpoints. Types are **inferred** with `z.infer`, never
      hand-written beside the schema.
- [ ] `.strict()` on every request schema. `api/conventions.md` §3: unknown fields are **rejected**, not
      ignored. Add one spec proving an unknown field is a 400 with `UNKNOWN_FIELD`, because this is the
      rule most easily lost to a later refactor.
- [ ] `Principal` is a discriminated union — `{ kind: 'user', userId, sessionId }` or
      `{ kind: 'apiKey', keyId, organizationId, permissions }`. **The API-key arm is defined and
      unimplemented in Phase 2** (API keys are not in this phase's scope). Defining it now is what makes
      every guard downstream written once, per `authentication.md` §1. Any code that must handle it
      throws a clearly-worded "not implemented in Phase 2" error rather than silently allowing.
- [ ] `TenantContext` — `{ organizationId, membershipId, roleKey, permissions: ReadonlySet<Permission> }`.
      This is what handlers receive and what the tenant-scoped Prisma client is bound to.
- [ ] Password policy as a schema: minimum 12 characters, **no composition rules, no maximum below 128**,
      per `authentication.md` §2. A spec asserts a 12-character all-lowercase password is *accepted* —
      the rule is a floor on length, and a reviewer who "helpfully" adds a symbol requirement must see a
      test go red.
- [ ] Extend `packages/contracts/src/ids.ts` with the new prefixed ID schemas (`ses_`, `mfa_`, `vtk_`,
      `rcv_`).
- [ ] Export everything from `index.ts`. Nothing in `apps/*` may import from a deep path.

**Verify:** `pnpm test`, `pnpm typecheck`, `pnpm build:packages`.

---

## Task 3: Password hashing and the breach check

**Files:** `apps/api/src/modules/auth/password.service.ts`, `breach-check.service.ts`, specs,
`packages/config/src/env.ts`, `.env.example`, `.claude/decisions/ADR-0014-*.md`, `ADR-0015-*.md`

- [ ] Add `@node-rs/argon2`. Parameters m=64MiB, t=3, p=4 as the starting point from
      `authentication.md` §2, held in **config, not constants**, so they can be raised without a code
      change.
- [ ] `hash(password)` returns a PHC string that embeds its own parameters. `verify(hash, password)`
      returns `{ valid, needsRehash }` — `needsRehash` is true when the stored parameters are weaker than
      current config, and the caller rehashes transparently on the next successful login. **Write the
      rehash test first**: hash with weak parameters, raise config, verify, assert `needsRehash` and that
      the stored hash is replaced.
- [ ] **Timing equality is the requirement, not a nice-to-have.** When no user exists, the login path
      must still perform a full Argon2id verification against a fixed dummy hash. Prove it with a
      statistical test: N attempts against an existing account and N against a non-existent one, assert
      the medians are within a stated tolerance. Document the tolerance and why — a strict equality
      assertion here is a flaky test, and a flaky security test gets deleted.
- [ ] HIBP k-anonymity client: SHA-1 the password, send **only the first 5 hex characters** to the range
      API, match the remaining 35 locally. The password never leaves the process. Write the test that
      asserts the outbound URL contains exactly 5 characters of the hash and nothing else — that
      assertion is the whole privacy claim.
- [ ] Behind `PASSWORD_BREACH_CHECK_ENABLED`, **default false in `test`**, so no test suite depends on
      a third party being reachable. A short timeout (2s) and **fail open** on any error, timeout, or
      non-200: log at `warn`, allow the password. Record in ADR-0015 that this is a deliberate
      availability-over-completeness trade, with the alternative (fail closed, and a HIBP outage stops
      all registration) named and rejected.
- [ ] A matched password is refused with a **clear explanation**, not a generic validation error —
      `authentication.md` §2 says the user is told why. This is a 422, not a 400: the shape was valid.
- [ ] **ADR-0014** for `@node-rs/argon2`: the alternative `argon2` compiles through node-gyp when no
      prebuilt matches, which reds a Windows dev box or a CI image; `hash-wasm` is meaningfully slower
      against a deliberate 250ms target. Both produce the same PHC strings, so the decision is reversible
      in code but not in the database — which is why it is an ADR.

**Verify:** `pnpm test`; the rehash, timing and 5-character-prefix specs all present and passing;
`pnpm lint` (the no-`any` and no-`console` rules bite here).

---

## Task 4: Single-use secret tokens

**Files:** `apps/api/src/modules/auth/token.service.ts`, spec, integration spec

- [ ] One service issuing all three token kinds — email verification, password reset, invitation — since
      `authentication.md` §6 gives them one discipline: 256-bit random from `crypto.randomBytes`, base64url
      encoded, **only a SHA-256 hash persisted**, single-use, expiring, invalidated by use or by a newer
      token of the same purpose for the same user.
- [ ] Consumption is a **conditional update, not read-then-write** — one `UPDATE ... SET consumedAt = now()
      WHERE tokenHash = ? AND consumedAt IS NULL AND expiresAt > now()`, accepted only if exactly one row
      was affected. Two concurrent redemptions of the same reset link must produce exactly one success.
      **Write that concurrency test** — fire both redemptions in parallel against real Postgres and assert
      one success and one failure. A read-then-write implementation passes every sequential test and loses
      this one.
- [ ] Issuing a new token of a purpose invalidates the outstanding ones for that user and purpose, in the
      same transaction as the insert.
- [ ] TTLs from §6, in config not constants: verification 24h, reset 1h, invitation 7d.
- [ ] The raw token is returned to the caller exactly once, for the mailer, and is **never** logged,
      never stored, and never included in an audit event's metadata. Add a spec that runs the redacting
      logger over a token-carrying object and asserts the value does not appear in the output.

**Verify:** `pnpm test`, `pnpm test:integration` (the concurrency test needs real Postgres — an in-memory
double cannot prove this).

---

## Task 5: Mail infrastructure and templates

**Files:** `apps/api/src/infrastructure/mail/*`, `apps/api/src/modules/auth/emails/*`,
`.claude/decisions/ADR-0016-*.md`, `.claude/architecture/integrations.md` (update)

- [ ] A `Mailer` port with `send({ to, subject, html, text })` and one SMTP adapter pointed at Mailpit
      via the existing `MAIL_HOST`/`MAIL_PORT` config. Every email is real, visible in Mailpit's UI, and
      assertable in CI without an external account.
- [ ] Templates for: email verification, password reset, **password changed** (a security notice, not a
      request), **MFA enabled/disabled**, invitation, and **new sign-in from a new device**. §2 and §5
      both require the notice emails; they are not optional extras.
- [ ] Every template renders **both** `html` and `text`. A text part is what makes the mail deliverable
      and readable in a client that blocks HTML, and building it later means rewriting every template.
- [ ] Links are absolute and built from `WEB_BASE_URL` — never from a request `Host` header. A
      host-header-derived reset link is a well-known account-takeover primitive; add a spec that asserts
      the link origin comes from config and is unaffected by an attacker-supplied `Host`.
- [ ] Sending is **outside** the database transaction but only after it commits. A mail send inside a
      transaction either holds the transaction open on network I/O or sends mail for a change that then
      rolls back. Both are wrong; state which one you chose against in a comment.
- [ ] Integration test reads Mailpit's HTTP API to assert the message arrived, its recipient, its subject,
      and that the body contains a link matching the expected route — not merely that `send` was called.
      A mock here would be mocking the thing under test.
- [ ] **ADR-0016**: SMTP-first, Resend deferred. The reason is the honesty rule — a Resend adapter with no
      API key and no verified domain is unverified code claiming to be a feature, and nothing is deployed
      yet. Name the trigger for revisiting: the first staging deploy.

**Verify:** `pnpm test`, `pnpm test:integration` with the compose stack up (Mailpit is already in it).

---

## Task 6: Session service — issue, rotate, revoke, cache

**Files:** `apps/api/src/modules/auth/session.service.ts`, `session.repository.ts`, `cookies.ts`,
specs, integration specs

- [ ] Issue: 256-bit token, SHA-256 hash stored, raw token returned once for the cookie. The database
      cannot mint a session, per §3.
- [ ] Cookie exactly as §3 specifies: `__Host-session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
      no `Domain`. **Verify the `__Host-` prefix actually works over `http://localhost`** before building
      on it — browsers treat localhost as a trustworthy origin and accept `Secure` there, but confirm it
      in a real Chromium rather than assuming, because if it does not hold, every E2E test in Task 18
      fails for a reason that looks like an application bug.
- [ ] Two lifetimes, both enforced, and a test for each independently: **absolute** 7 days (30 with
      remember-me) and **idle** 24h from `lastSeenAt`. Rolling renewal past the halfway mark of the idle
      window — not on every request, which would write to the database on every read.
- [ ] **Rotation on every privilege change**: login, MFA completion, password change, role change. Rotate
      means issue a new token, mark the old row rotated, set `rotatedFromId`. This is the session-fixation
      defence and the test names it as such.
- [ ] Redis cache of the session lookup with a short TTL. **Revocation deletes the cache entry and the
      row together, in that order**, so a revoked session cannot be served from cache. Write the test
      that proves immediacy: authenticate, revoke, and assert the *very next* request is 401 — this is
      one of the three phase exit criteria and it is the one most easily satisfied only "eventually".
- [ ] Redis unavailable must **fall back to reading Postgres**, not fail. ADR-0005 promises this
      explicitly. Test it by pointing the client at a dead Redis.
- [ ] `revokeAllForUser(userId, { except })` and `revokeAllForUserInOrganization(userId, orgId)` — needed
      by password change (§2), reset (§6) and member removal (`permissions.md` invariant 5).
- [ ] Sessions record `ip`, `userAgent`, `createdAt`, `lastSeenAt` so `/settings/security` can list them.
      `userAgent` is user-controlled input: length-cap it and never render it unescaped.

**Doc ownership:** `.claude/security/authentication.md` §3 — its "Status: Designed. Not Implemented"
banner becomes false for sessions in this task. Update the banner to name what is built and what is not.

**Verify:** `pnpm test`, `pnpm test:integration`, and the revocation-immediacy test explicitly named in
the task report.

---

## Task 7: Authentication guard, `Principal`, CSRF, CORS

**Files:** `apps/api/src/common/guards/authentication.guard.ts`, `csrf.guard.ts`,
`apps/api/src/common/decorators/access.decorator.ts` (extend), `common/access-assertion.ts` (extend),
`apps/api/src/main.ts`, `.claude/decisions/ADR-0017-*.md`

- [ ] A global `AuthenticationGuard` resolving the session cookie to a `Principal` and attaching it to the
      request. `@Public()` routes skip it. Missing or invalid credential → 401 `UNAUTHENTICATED`; expired
      or revoked → 401 `SESSION_EXPIRED`. The two codes are distinct in `api/authentication.md` §6 and
      must stay distinct — they tell the frontend whether to show "log in" or "your session ended".
- [ ] Add the third access declaration, `@AuthenticatedOnly()`, which `security/authorization.md` §5 names
      and Phase 1 did not build. Extend `AccessDeclaration` to three arms and **extend the boot-time
      assertion**, do not relax it: a route declaring nothing must still refuse startup. Add the test that
      a route with no declaration crashes the boot — the existing one proves it for two arms and must not
      silently start passing for three.
- [ ] A `PENDING_MFA` session authenticates **nothing except** the MFA verification endpoint. Every other
      route rejects it with 401 `MFA_REQUIRED`. Write the test that a pending session cannot read
      `/api/v1/auth/session` — a pending credential that can read anything is the whole MFA bypass.
- [ ] CSRF: double-submit per §4. A non-`HttpOnly` `__Host-csrf` cookie, echoed in `X-CSRF-Token`,
      compared with `crypto.timingSafeEqual`, **bound to the session** so a token from one session does not
      validate another. Applies to cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` only. Bearer requests
      are exempt. Missing or mismatched → 403 `CSRF_TOKEN_INVALID`.
- [ ] `Origin` and `Sec-Fetch-Site` are checked as a **secondary** signal, per §4 — they refuse an obviously
      cross-site request but they are not the control, and the comment must say so, or a later reader will
      delete the double-submit as redundant.
- [ ] CORS: an explicit allowlist containing `WEB_BASE_URL` only, `credentials: true`, and the allowed
      headers/methods enumerated. **Never reflect the request `Origin`** and never `*` with credentials —
      add a spec asserting an unknown origin gets no `Access-Control-Allow-Origin` header at all.
- [ ] Wire the Phase 1 rate limiter to the auth routes for the first time: `login`, `registration`,
      `passwordReset`, `emailVerificationResend` classes from `rate-limit.config.ts`, all of which already
      exist and govern nothing. This is the task where `abuse-prevention.md`'s "Implemented, governing
      nothing" note stops being true — **update that document in this task**, not at the end of the phase.
- [ ] **ADR-0017** for CORS-with-credentials over a Next-side proxy: the proxy would make requests
      same-origin and sidestep CORS entirely, at the cost of a hop and of `apps/web` holding routing
      authority it otherwise does not have. Name it as the alternative and say what would make us switch.

**Doc ownership, and this task carries the most of it:**
`.claude/security/abuse-prevention.md` — the "Implemented (Phase 1), governing nothing yet" banner and
its "limits no endpoint today" paragraph both become false the moment the auth routes carry limit
classes. `.claude/security/authentication.md` §4 (CSRF). `.claude/api/authentication.md` §3.
`.claude/architecture/backend.md` §3 — the cross-cutting pipeline gains two live stages.
`.claude/development/setup.md` — any new environment variable.

**Verify:** `pnpm test`, `pnpm test:integration`, `pnpm check:openapi`, and a boot of the app proving the
access assertion still crashes on an undeclared route.

---

## Task 8: Registration and email verification

**Files:** `apps/api/src/modules/auth/auth.controller.ts`, `registration.service.ts`,
`email-verification.service.ts`, `apps/api/src/modules/users/*`, specs and integration specs

- [ ] `POST /api/v1/auth/register` — validate, breach-check, hash, create `User` + `Credential`, issue a
      verification token, send the mail, write an audit event. All database work in **one transaction**;
      the mail send after commit.
- [ ] **The response is identical whether or not the address already exists.** Same status, same body.
      An existing address gets a "someone tried to register with your address" email instead of a
      verification link. Write the enumeration test as a byte-comparison of the two responses, not an
      eyeball check.
- [ ] `POST /api/v1/auth/verify-email` consumes the token via Task 4's conditional update and sets
      `emailVerifiedAt`. `POST /api/v1/auth/resend-verification` is rate-limited per account and per IP.
- [ ] **Unverified users may sign in but cannot create organisations, invite, or scan** — §6's table.
      Build this as a reusable guard checking `emailVerifiedAt`, returning 403 `EMAIL_NOT_VERIFIED`, and
      apply it to organisation creation in Task 13. A gate that exists but is applied nowhere is not a
      gate; the test must assert it on a real endpoint.
- [ ] Audit events for `user.registered` and `user.email_verified`. `AuditEvent.organizationId` is
      non-nullable and these happen before any organisation exists — resolve this deliberately and write
      down which you chose: either these events are not audited at this stage, or the schema gains a
      platform-scoped audit path. **Do not quietly skip the audit** and leave rule 10 looking satisfied.

**Doc ownership:** `.claude/security/authentication.md` §6 (verification token row, and the
unverified-user gating rule this task actually enforces). `.claude/api/authentication.md` — the
registration and verification endpoints, which the committed OpenAPI document now contains.

**Verify:** `pnpm test`, `pnpm test:integration`, `pnpm check:openapi`, `pnpm check:registry`.

---

## Task 9: Login, logout, session endpoint, lockout

**Files:** `apps/api/src/modules/auth/login.service.ts`, controller additions, specs, integration specs

- [ ] `POST /api/v1/auth/login` → `{ mfaRequired: false }` plus the session cookie, or
      `{ mfaRequired: true, pendingToken }` when a confirmed `MfaFactor` exists. Exactly the two shapes in
      `api/authentication.md` §2 — the OpenAPI document is the contract and `check:openapi` will hold you
      to it.
- [ ] Full Argon2id verification against a dummy hash when the account does not exist, so timing does not
      distinguish. Reuse Task 3's dummy-hash path rather than reimplementing it.
- [ ] Progressive delay then temporary lock per account, with **independent per-IP limits**, per §7 — one
      attacker must not be able to lock out an entire tenant by guessing at their addresses. That is the
      property the test asserts, not merely that a lock happens.
- [ ] Failed logins are audited with IP and user agent. A burst notifies the account owner by email
      (Task 5's template).
- [ ] Successful login rotates the session, resets `failedLoginCount`, sets `lastLoginAt`, and sends the
      new-device notice when the user agent and IP are unfamiliar.
- [ ] `POST /api/v1/auth/logout` → 204, cookie cleared, **session row deleted and cache entry deleted**.
- [ ] `GET /api/v1/auth/session` returns the principal, the active organisation, the effective permission
      set, and an entitlements placeholder. The frontend's permission-aware UI reads this and nothing else.
- [ ] 401 `ACCOUNT_LOCKED` is wrong — `api/authentication.md` §6 says **403**. Follow the document.

**Doc ownership:** `.claude/security/authentication.md` §2 (password verification and timing equality)
and §7 (brute force and enumeration) — both stop being aspirational here.
`.claude/api/authentication.md` §2 and §6.

**Verify:** `pnpm test`, `pnpm test:integration`, `pnpm check:openapi`.

---

## Task 10: Password reset

**Files:** `apps/api/src/modules/auth/password-reset.service.ts`, controller additions, specs

- [ ] `POST /api/v1/auth/forgot-password` — **identical response whether or not the address exists**, rate
      limited per address and per IP (3/hour and 10/hour, from `abuse-prevention.md` §1).
- [ ] `POST /api/v1/auth/reset-password` consumes the token, breach-checks and hashes the new password,
      and **revokes every session for that user** — §6. Send the "password changed" notice.
- [ ] `POST /api/v1/auth/change-password` (authenticated) requires the **current** password, revokes all
      *other* sessions while rotating the current one, and emails the notice. Losing your own session on
      a password change is a usability bug; keeping every other one is a security bug.
- [ ] Audit events for reset requested, reset completed, and password changed.

**Doc ownership:** `.claude/security/authentication.md` §6 (reset token row and the
revoke-all-sessions rule). `.claude/security/audit.md` §4 if the action taxonomy gains rows.

**Verify:** `pnpm test`, `pnpm test:integration`, `pnpm check:openapi`.

---

## Task 11: TOTP MFA and recovery codes

**Files:** `apps/api/src/modules/auth/mfa.service.ts`, `totp.ts`, `recovery-codes.service.ts`,
controller additions, `.claude/decisions/ADR-0018-*.md`, specs

- [ ] TOTP per RFC 6238: 30-second step, **±1 window** for clock drift, 6 digits. Test against the RFC's
      own published test vectors — a hand-rolled TOTP that passes only its own round-trip test is a
      coin-flip against a real authenticator app.
- [ ] The secret is generated server-side, **encrypted at rest** with the application key (not hashed —
      it must be recoverable to verify), and shown once as a QR-code `otpauth://` URI.
- [ ] **The factor is only persisted as `confirmedAt` after the user proves one correct code.** A factor
      row may exist unconfirmed; an unconfirmed factor does not gate login. Test that enrolling and
      abandoning halfway leaves the account exactly as it was.
- [ ] Ten single-use recovery codes, **Argon2id-hashed** (they are human-typed and lower-entropy than a
      256-bit token, so SHA-256 is not enough), shown once, regenerable. Using one marks it `usedAt`;
      the same code must fail the second time. Test that explicitly.
- [ ] `POST /api/v1/auth/mfa/verify { pendingToken, code }` accepts a TOTP code **or** a recovery code,
      completes the pending session, and **rotates it** into a full session. Failed attempts are rate
      limited and **lock the pending session after 5**, per §5.
- [ ] Enabling or disabling MFA requires the **current password**, writes an audit event, and emails the
      user. Disabling without a password check is an obvious account-takeover step from a stolen session.
- [ ] Replay: a TOTP code that has just been accepted must not be accepted again inside its window. Store
      the last accepted step per factor and reject it. This is the standard TOTP flaw and it is not
      covered by the ±1 drift window.
- [ ] Organisation-level `requireMfa`: a member without a confirmed factor is forced into enrolment
      before any other action, **enforced server-side on every request** and not only at login (§5). The
      guard is written here; Task 12 places it in the pipeline.
- [ ] **ADR-0018**: the pending MFA credential is a `Session` row in `PENDING_MFA` status rather than a
      Redis-only token. It reuses revocation, makes "rotate on privilege change" literal, and survives a
      Redis restart mid-login. The cost is a database write per login attempt that reaches MFA; name it.

**Doc ownership:** `.claude/security/authentication.md` §5 in full — every bullet in it is either
built or deliberately deferred by this task, and the section must say which. Note the replay defence
explicitly: it is a control §5 does not currently mention, and an undocumented control is one a future
refactor deletes. `.claude/api/authentication.md` §2 (the MFA verify endpoint).

**Verify:** `pnpm test` (RFC vectors, replay, recovery single-use), `pnpm test:integration`,
`pnpm check:openapi`.

---

## Task 12: Tenant resolution and the authorization guard

**Files:** `apps/api/src/common/guards/authorization.guard.ts`, `tenant-context.ts`,
`apps/api/src/common/decorators/ctx.decorator.ts`, `apps/api/src/modules/roles/*`, specs

- [ ] Implement `security/authorization.md` §2's six layers **in order**, each able to deny and none able
      to override a denial: authentication (401) → membership (**404**) → organisation state (403
      `ORGANIZATION_SUSPENDED`) → permission (403 `PERMISSION_DENIED`) → resource scope (404) →
      entitlement (402). Entitlement is a **stub that always allows** in Phase 2, with a comment naming
      Phase 10 — a stub that denies nothing is honest; a missing layer is a hole.
- [ ] **Tenant resolution happens before authorization**, per `architecture/overview.md` §4, so a
      permission is always evaluated against a specific organisation. The active organisation comes from
      the session's `activeOrganizationId`, never from a request parameter, never from a header.
- [ ] `@RequirePermission()` finally does something. The guard reads the route's declaration, computes
      the effective permission set from the membership's role via seeded `RolePermission` rows, and
      denies on absence. Wire the tenant-scoped Prisma client to the resolved `organizationId` and hand
      it to the handler.
- [ ] **The 403/404 discipline is the test that matters**, per §6: a resource in another tenant returns
      **404, identical to genuinely absent**. Same status, same body, same headers. Assert all three.
- [ ] Build the **generated authorization matrix test** the exit criterion names. It enumerates the route
      inventory Phase 1 already builds and, for every non-public route, asserts unauthenticated → 401,
      authenticated-without-permission → 403, authenticated-in-another-tenant → 404, correct permission →
      2xx. **A new endpoint with no matrix coverage must fail the test**, not be silently skipped — that
      inversion is the difference between a matrix and a checklist.
- [ ] A permission cache invalidated **on write, not on a timer** — `permissions.md` invariant 4 says a
      role change takes effect on the member's next request. Test it: change a role, next request reflects
      it.
- [ ] Place the `requireMfa` and `emailVerifiedAt` gates in the pipeline here.

**Doc ownership:** `.claude/security/authorization.md` — the whole document's "Designed. Not
Implemented" banner falls here, and §5's claim about `@RequirePermission()` becomes true for the first
time. `.claude/architecture/backend.md` §3. `.claude/product/permissions.md` if any grant moved.
`.claude/product/roadmap.md` — this is the checkpoint below, so it gets an evidence table.

**Verify:** `pnpm test`, `pnpm test:integration`, the matrix test green over every existing route,
`pnpm check:openapi`, `pnpm check:registry`.

---

## Checkpoint A — after Task 12: the identity API, enforced, with no UI

**Stop here.** This is a milestone in its own right and it gets recorded before Task 13 begins.

What is true at this point, and it is worth stating because it is the first time any of it has been
true in this repository: a request arrives, is rate-limited, is authenticated against an opaque
server-side session, is CSRF-checked if it carries a cookie, resolves to a tenant, and is authorized
against a permission the route declares — and every one of those stages can deny. Nothing in
`apps/web` has been touched.

- [ ] Run `sentinel-verify` in full: `format:check`, `lint`, `typecheck`, `test`, `check:specs`,
      `check:openapi`, `check:registry`, `test:integration`, `build`, plus `prisma migrate deploy`
      against a **fresh empty database**. `test:e2e` runs but proves only that the Phase 1 smoke specs
      still pass — say exactly that in the row, and no more.
- [ ] Push the branch and get a green CI run on a Linux runner. Cite it by run ID. Twelve tasks of
      unpushed work is a long time to have never seen the pipeline.
- [ ] Write the evidence table into `roadmap.md` and move Phase 2 to **Partially Implemented** with the
      gap named precisely: *"identity API built and enforced end to end; no authentication UI exists,
      so the E2E journey exit criterion is unmet and the phase is not complete."* Partially Implemented
      with a named gap is a real status — `sentinel-verify` §3 says so explicitly, and using it here is
      the point of having it.
- [ ] Confirm the three exit criteria's actual state rather than implying it. At Checkpoint A:
      *sessions revoke immediately* is **met and proven** (Task 6); *the authorization matrix passes for
      every existing endpoint* is **met** (Task 12) — noting honestly that "every existing endpoint" is
      a smaller set than it will be after Tasks 13–15; *the full authentication journey passes E2E* is
      **unmet**, and cannot be met until Task 18.
- [ ] Write the ledger entry and update `progress.md`'s pause state, then stop and report to the
      operator.

**Do not skip this because the work is going well.** The window between building something and
recording it is exactly when a session ends unexpectedly, and twelve tasks is the largest such window
in this plan.

---
## Task 13: Organisations and organisation switching

**Files:** `apps/api/src/modules/organizations/*`, specs, integration specs

- [ ] `POST /api/v1/organizations` — creates the organisation, the creator's `OWNER` membership, and the
      audit event **in one transaction**. Requires a verified email (Task 8's gate). Slug uniqueness is a
      database constraint first, application check second.
- [ ] `GET /api/v1/organizations` lists the caller's organisations. `GET`/`PATCH` on one requires
      `organization.read` / `organization.update`. `DELETE` requires `organization.delete` and must
      contend with `AuditEvent`'s `onDelete: Restrict` — deletion fails while audit events exist, by
      design. Decide and document the Phase 2 behaviour: most likely 409 with a clear message, with the
      real purge path deferred to Phase 11's platform admin. **Do not weaken the constraint.**
- [ ] `POST /api/v1/auth/switch-org { organizationId }` — verifies active membership, **rotates the
      session**, updates `activeOrganizationId`, returns the new context and permission set. Switching to
      an organisation you do not belong to is **404**, not 403.
- [ ] Every list endpoint paginates (`api/pagination.md`). No unbounded queries, per the core rules.
- [ ] Cross-tenant isolation tests are **mandatory** for every tenant-owned resource touched here.

**Verify:** `pnpm test`, `pnpm test:integration`, matrix test, `pnpm check:openapi`, `pnpm check:registry`.

---

## Task 14: Memberships, roles, and the last-owner invariant

**Files:** `apps/api/src/modules/memberships/*`, `apps/api/src/modules/roles/*`, specs

- [ ] List members (paginated), change a member's role, remove a member. All require
      `organization.manage_members`; role changes require `organization.manage_roles`.
- [ ] **Invariant 1: an organisation always has at least one `OWNER`.** The last owner cannot be removed
      or demoted; the API rejects it with 422. Test the race too — two concurrent demotions of the two
      remaining owners must not both succeed. That needs a transaction with the right isolation or a
      constraint, not two independent reads.
- [ ] **Invariant 5: removing a member revokes their sessions for that organisation immediately.** Reuse
      Task 6's `revokeAllForUserInOrganization`. Test that the removed member's next request is 401/404
      rather than eventually.
- [ ] Removal is a **soft delete** (`deletedAt`), which is why Task 1's partial unique index exists. Prove
      the round trip: add, remove, re-add.
- [ ] `GET /api/v1/roles` returns the seeded system roles and their permissions, for the UI's role picker.
      Custom roles are **Phase 11** — say so in the response documentation rather than leaving a gap.
- [ ] Every change writes an audit event in the same transaction, with before/after role in metadata.

**Verify:** `pnpm test`, `pnpm test:integration`, matrix test, `pnpm check:openapi`.

---

## Task 15: Invitations

**Files:** `apps/api/src/modules/invitations/*`, specs, integration specs

- [ ] Create (requires `organization.manage_members`), list, revoke, and accept. 7-day TTL, hashed at
      rest, single-use, **bound to the invited address** — accepting requires authentication as that
      address, per §6's table. Test that a different signed-in user cannot consume someone else's
      invitation; that is the interesting attack, not the happy path.
- [ ] The invited role can never exceed the inviter's own permissions — the same
      no-minting-authority-you-lack rule as custom roles (`authorization.md` §4).
- [ ] Accepting creates the `Membership` and consumes the invitation **in one transaction**. An invitation
      for an address with no account yet routes through registration and is consumed after verification.
- [ ] Rate limit: 50/day per organisation, the `invitations` class already in `rate-limit.config.ts`.
- [ ] Re-inviting a removed member must work — this is the concrete case Task 1's partial index unblocks,
      and the end-to-end test for it lives here.
- [ ] Audit events for invitation sent, revoked, accepted, and expired.

**Verify:** `pnpm test`, `pnpm test:integration`, matrix test, `pnpm check:openapi`, `pnpm check:registry`.

---

## Task 16: `apps/web` — the authentication screens

**Files:** `apps/web/app/(auth)/*`, `apps/web/src/api-client.ts`, `apps/web/src/auth/*`,
`packages/ui` additions

- [ ] Screens under the existing `(auth)` route group, which Phase 1 built as a layout with **no routes
      under it at all**: `/register`, `/verify-email`, `/login`, `/login/mfa`, `/forgot-password`,
      `/reset-password`.
- [ ] React Hook Form + Zod, with the **same schemas** from `packages/contracts` the API validates
      against. That shared schema is the point of `packages/contracts` being the spine — do not
      re-declare shapes in the web app.
- [ ] A typed API client that sends `credentials: 'include'`, attaches `X-CSRF-Token` from the `csrf`
      cookie on unsafe methods, and maps the error envelope to field-level errors. One place, not per form.
- [ ] Every one of `architecture/frontend.md` §6's required states on every screen: loading, empty, error,
      and success. `user-flows.md` §8 additionally requires that a **session expiry returns to login and
      restores the intended destination** — build that redirect-back now, while there are few routes.
- [ ] `packages/ui` gains only what these screens genuinely need. Five of the eight Phase 1 primitives
      (Button, Input, Label, Field, Skeleton) have **never been painted by a browser** — these screens are
      the first real use, so expect and fix defects that jsdom could not show.
- [ ] Accessibility is not a later pass: labelled inputs, a visible focus ring, errors tied to their
      control with `aria-describedby` (which `Field` already does), and the MFA code input typed
      `inputMode="numeric"` with `autocomplete="one-time-code"`.
- [ ] Nothing here is a security control. Every affordance is re-authorised server-side.

**Verify:** `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm test:e2e`, and **a human loads each screen in a
browser** — the Phase 1 note that no browser has painted these primitives is closed by looking, not by a
passing jsdom test.

---

## Task 17: `apps/web` — app shell, organisation switcher, `/settings/security`

**Files:** `apps/web/app/(app)/*`, `apps/web/src/auth/session-provider.tsx`, `packages/ui` additions

- [ ] The `(app)` shell fetches `GET /api/v1/auth/session` once and provides principal, active
      organisation and permission set through context. TanStack Query is already wired and currently
      queries nothing; this is its first real use.
- [ ] Organisation switcher calling `switch-org`, then **invalidating every cached query** — stale
      tenant data rendered under a new organisation is a tenant-isolation failure the user can see.
      Test it.
- [ ] `/settings/security`: active sessions with IP, user agent, created and last-seen, each revocable
      individually and "revoke all others" as one action; MFA enrolment and disablement with the QR code
      and the one-time recovery-code display; password change.
- [ ] `/settings/members`: member list, role change, removal, pending invitations, invite form — every
      affordance gated on the permission set, and every one of them still rejected server-side if called
      directly. The `usePermission` helper is **UX only** and its docstring must say so.
- [ ] Recovery codes and any once-only secret get a screen that states plainly it will not be shown again,
      with copy and download. `api/authentication.md` §4 requires this for API keys and the same rule
      applies here.
- [ ] Replace the Phase 1 `/dashboard` placeholder's "not built" copy only as far as is true. There is
      still no product; do not build fake metric tiles. The Phase 1 roadmap's "no mock product UI" rule
      stands.

**Verify:** `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm test:e2e`, a human in a browser.

---

## Task 18: E2E journey suite, matrix in CI, ADRs, docs, roadmap

**Files:** `apps/web/e2e/*`, `.github/workflows/ci.yml`, `.claude/**`, `docs/build-manifest.html`

- [ ] The full journey as one Playwright spec, because that is the exit criterion **verbatim**: register →
      receive the verification email (read it from **Mailpit's API**, not a stubbed link) → verify → log
      in → enrol MFA → log out → log in again with a TOTP code generated in the test → create an
      organisation → invite a second user → accept as that user → switch organisations → revoke a session
      → confirm the revoked session is dead on its next request.
- [ ] Additional E2E paths that are failure paths, per `user-flows.md` §8: wrong password, expired reset
      link, reused reset link, MFA lockout after five attempts, session expiry restoring the intended
      destination.
- [ ] CI runs the authorization matrix test as its own named step so a failure reads as "authorization
      matrix failed" rather than as a generic test failure.
- [ ] **This task does not update documentation — it audits it.** Every `.claude/` document is owned by
      the task that made its text false, per Execution protocol §6, and each task above names the
      documents it owns. What happens here is the sweep: walk the **Doc ownership** line of Tasks 1–17,
      confirm each named document was actually changed in that task's commit range with
      `git log -- <path>`, and fix what was missed. A document nobody owned is the finding.
- [ ] The two documents genuinely owned by this task, because only the finished phase makes them false:
      `architecture/frontend.md`'s route table, and `development/testing.md` §3's "what must be tested"
      list now that the E2E journeys exist.
- [ ] ADRs 0014–0018 written **when their decisions were made** (Tasks 3, 5, 7, 11), not retrofitted here.
      This task only adds their rows to `.claude/decisions/README.md` and checks none was missed.
- [ ] Run `sentinel-verify` and record the evidence table in `roadmap.md`. **Move Phase 2's status to
      whatever the evidence supports and no further.** Partially Implemented with a named gap is a real
      and useful status.

**Verify — this is the phase gate, so all of it:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm check:specs`, `pnpm check:openapi`, `pnpm check:registry`, `pnpm test:integration`,
`pnpm build`, `pnpm test:e2e`, `prisma migrate deploy` against a **fresh empty database**, and a green CI
run on a Linux runner cited by run ID.

---

## Risks specific to this phase

| Risk | Why it bites here | Mitigation in this plan |
|---|---|---|
| `__Host-` + `Secure` cookies over `http://localhost` | If browsers reject them, every E2E test fails in a way that looks like an application bug | Verified in a real Chromium in Task 6, before anything depends on it |
| Enumeration creeping back | Registration, login and reset each have three or four branches, and one of them returning a different shape leaks account existence | Byte-comparison tests, not eyeball checks (Tasks 8, 9, 10) |
| Timing tests flaking in CI | A flaky security test gets deleted, and the control goes with it | Statistical comparison with a stated, documented tolerance (Task 3) |
| The matrix test degrading into a checklist | A new endpoint silently skipped is exactly the hole the test exists to prevent | The test enumerates the route inventory and fails on uncovered routes (Task 12) |
| Audit before an organisation exists | `AuditEvent.organizationId` is non-nullable; registration has no organisation | Resolved deliberately and written down in Task 8, not skipped |
| Rate limiter's first real use | It has governed nothing since Phase 1 — the first endpoints it guards are where wiring defects surface | Task 7 wires it and updates `abuse-prevention.md` in the same change |
| MFA replay inside the drift window | The standard TOTP flaw, not covered by the ±1 window | Last-accepted-step stored per factor (Task 11) |
| A Phase 1 primitive breaking on first paint | Five of eight have only ever run in jsdom | Task 16 expects defects and budgets for them |
