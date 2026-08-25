# Phase 2 · Task 4 — brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch.

**Task:** Single-use secret tokens.
**Plan section:** `docs/superpowers/plans/2026-08-24-phase-2-identity.md`, "Task 4".
**Mode:** fresh implementer subagent + separate adversarial reviewer. Task 4 is one of the five
self-contained tasks (1, 3, 4, 5, 11) in the plan's Execution protocol §2. **It is not chained to
any task.** It depends on Task 2 only. Tasks 6, 8, 10 and 15 depend on its output.
**Branch:** `feat/phase-2-task-04`, cut from `main`. PR #6 rebase-merged Task 3 into `main` on
2026-08-25 at 15:55Z; every `feat/` branch older than that is behind or duplicate. Do not use one.

## What the previous task left, and what was re-verified before dispatch

Task 3 was re-verified by this session on `main` at `a0b1fc9` rather than taken from its report.
All exit 0, captured outside a pipe: `pnpm format:check`, `pnpm lint` (14 tasks), `pnpm typecheck`
(14 tasks), `pnpm test` (**48 files / 596 tests**), `pnpm check:specs` (**59 spec files**),
`pnpm test:integration` (**11 files / 148 tests**), `pnpm build` (8 tasks), `pnpm check:openapi`
(**4 routes**), `pnpm check:registry` (**14 models**), `docker compose ps` (all four healthy).

Those are the numbers your own run must move from. `check:openapi` must still say **4 routes**
when you are done: this task ships no endpoint.

Carry-forward rulings in [`../progress.md`](../progress.md) that bind this task directly: **13**
(a restated Prisma enum needs a parity spec), **27** (an error code goes in *both* lists), **30**
(`apiEnvSchema` is a `ZodEffects` — add variables inside the base object, before the
`.superRefine`, never with `.extend()`). Ruling **9** is context: `VerificationToken` is a
deliberately-global model with no RLS behind it, so nothing in the database will catch a query
that forgets whose token it is reading.

## Decisions already made — read these, do not re-derive them

- [`.claude/security/authentication.md`](../../../../../.claude/security/authentication.md) **§6**
  is the contract: 256-bit random, hashed at rest, single-use, expiring, invalidated by use or by
  a newer token, delivered only by email. TTLs 24h / 1h / 7d.
- `opaqueTokenSchema` in `packages/contracts/src/auth.ts:56` is already
  `z.string().min(1).max(512)` and its docblock already says the issuing format belongs to this
  task. **Do not change that schema.** A 43-character base64url token fits it.
- **No ADR is owed by this task.** §6 already fixes the discipline, so there is no open decision
  expensive enough to reverse. ADR-0016 belongs to Task 5. **You do not write or edit ADRs.**

## Orchestrator rulings taken before dispatch

Ten places where the plan's text does not resolve against what is in the repository. Each carries
the cost if the ruling is wrong. **The implementer follows these; it does not relitigate them.**
If one turns out to be impossible, stop and report — do not silently choose differently.

### Ruling 1 — the service ships two layers, and invitations use only the lower one

The plan says "one service issuing all three token kinds". That cannot mean one table:

- `VerificationToken` (`packages/db/prisma/schema.prisma:312`) has a **required** `userId` FK to
  `User` and a `purpose` of type `VerificationPurpose`, whose only two values are
  `EMAIL_VERIFICATION` and `PASSWORD_RESET` (`schema.prisma:69-72`).
- `Invitation` (`schema.prisma:496`) is tenant-owned and carries its **own** `tokenHash` (unique),
  `expiresAt`, `acceptedAt` and `revokedAt`. An invitee may have no `User` row at all.

So:

- **Layer 1 — the primitive.** Mint a token and hash it. This is what Task 6 will use for
  `Session.tokenHash` (`schema.prisma:178`) and Task 15 for `Invitation.tokenHash`. It touches no
  table and is a pure function of `crypto`.
- **Layer 2 — `VerificationToken` persistence.** `issue` and `consume`, for the two purposes the
  Prisma enum actually has.

**Cost if wrong:** forcing invitations into `VerificationToken` needs a migration, an enum value,
and a `userId` for a person who may not exist — and leaves `Invitation.tokenHash` as a second,
contradictory source of truth.

### Ruling 2 — do not add a value to `VerificationPurpose`

Ruling 13 makes a new Prisma enum value turn `packages/db/src/enum-parity.spec.ts` red until both
lists are extended. Task 4 adds no enum value and writes no migration. **`pnpm check:registry`
must still report 14 models.**

**Cost if wrong:** an unnecessary migration in a task the plan gave none, and Task 1's ruling 1
(each migration must leave the database sound on its own) becomes live again for no gain.

### Ruling 3 — consumption is a conditional update and the affected-row count is the decision

One statement:

```
updateMany({ where: { tokenHash, consumedAt: null, expiresAt: { gt: <now> } },
             data:  { consumedAt: <now> } })
```

accepted **if and only if `count === 1`**. Prisma compiles `updateMany` to a single `UPDATE`, so
the database does the arbitration.

A `findUnique({ where: { tokenHash } })` before the update, to recover `userId` and `purpose` for
the caller, **is permitted as a hint and never as the gate**. The update's count decides; the read
may be stale and must not be trusted for the accept/refuse branch.

**Cost if wrong:** a read-then-write implementation passes every sequential test and lets two
concurrent redemptions of one password-reset link both succeed. That is an account-takeover race,
not a tidiness point, and Ruling 10 is the test that catches it.

### Ruling 4 — the expiry clock is the API process clock, not the database's

`expiresAt` is stamped with `new Date()` at issue and compared with `new Date()` at consume, so
one clock both writes and reads. The alternative — raw `UPDATE … WHERE "expiresAt" > now()
RETURNING …` — buys the database as sole clock authority at the price of hand-written SQL with
quoted camelCase identifiers and untyped result rows. Not worth it against TTLs measured in hours.

**Cost if wrong:** skew *between* API instances shifts a token's effective lifetime by that skew,
in either direction. Bounded by NTP, irrelevant against 1h–7d. It cannot affect the concurrency
property in Ruling 3, which the single `UPDATE` guarantees regardless of clock.

### Ruling 5 — supersession sets `consumedAt`; no new column, no migration

Issuing a token invalidates the outstanding ones for that user and purpose **in the same
transaction as the insert** (`$transaction`). Invalidation means setting `consumedAt`, because §6
treats "used" and "superseded by a newer token" as one outcome and the schema has exactly one
column for it. This also keeps the consume predicate a single `consumedAt IS NULL`.

**Cost if wrong:** a row can no longer distinguish "the user clicked the link" from "a newer
request replaced it". Accepted, because the forensic record is the `AuditEvent` the *endpoint*
writes (Tasks 8/10), not the token row. If Phase 3's audit work needs the distinction it adds an
`invalidatedAt` column then, against a table whose rows are all short-lived.

### Ruling 6 — this task writes no `AuditEvent`

`AuditEvent.organizationId` is NOT NULL with a `Restrict` FK to `Organization`
(`schema.prisma:534,546`). A verification or reset token is issued to a user who may belong to no
organisation, so this service has no value to put there. The plan's global constraint ("every
mutation writes an `AuditEvent` in the same transaction") binds the **endpoint**, which has the
organisation context.

**Carry-forward, and say so in your report** so the orchestrator can record it for Tasks 8, 10 and
15: the audit event is theirs to write, and **the raw token never enters `metadata`.**

**Cost if wrong:** inventing an organisation id here would either fabricate a foreign key or make
token issuance fail for users who have not created an organisation yet — which is every user
during registration.

### Ruling 7 — one new error code, `TOKEN_INVALID`, added to both lists, and it does not say why

Invalid, expired, already consumed, and superseded all produce the **same code and the same
message**. Add `TOKEN_INVALID` to:

1. `packages/contracts/src/error-codes.ts`, in the **Validation** group beside `PASSWORD_BREACHED`.
2. `.claude/api/errors.md` §3's **Validation** line. That is a mechanical edit to an existing
   comma-separated list — it is the one `.claude/` edit you are authorised to make (plus
   `.env.example` under Ruling 8, and `operations/monitoring.md` §2 **only if** Ruling 9's
   measurement forces it).

Define the error in `apps/api/src/modules/auth/`, following `password-breached.error.ts` exactly:
extend `DomainError`, **422**, per `api/conventions.md` §2's "valid shape, failed a domain rule" —
the same reasoning `PasswordBreachedError` records. Nothing raises it yet; Tasks 8 and 10 are its
callers. Pin with a spec that nothing token-derived reaches the message or the details.

**Cost if wrong:** three codes (`TOKEN_EXPIRED`, `TOKEN_CONSUMED`, `TOKEN_UNKNOWN`) would make the
consume endpoint an oracle — "expired" confirms the token once existed, which confirms the address
is registered, which is exactly what §6's "response is identical whether or not the address exists"
forbids.

**If you have room, build the parity spec ruling 27 has been asking for since Task 3:** cross-check
`ERROR_CODES` against the backticked codes in `api/errors.md` §3, the way
`packages/db/src/enum-parity.spec.ts` cross-checks the enums. Prove it goes red by mutating each
side in turn. If §3's markdown will not yield a robust extraction, **say so with the evidence** and
ship without it — a fragile regex is worse than an honest gap.

### Ruling 8 — three TTL variables, all in seconds, on `apiEnvSchema`'s base object

```
TOKEN_TTL_EMAIL_VERIFICATION_SECONDS   default 86400    (24h, §6)
TOKEN_TTL_PASSWORD_RESET_SECONDS       default 3600     (1h,  §6)
TOKEN_TTL_INVITATION_SECONDS           default 604800   (7d,  §6)
```

Inside `apiEnvObject` in `packages/config/src/env.ts`, **before** the `.superRefine` — ruling 30.
Every one carries a default so nothing existing has to change to boot. Update `.env.example` with
a comment giving the human-readable value beside each number. API-only, not `sharedEnvSchema`, for
the reason written above the password block at `env.ts:44-47`.

One unit for all three, deliberately, rather than `_HOURS`/`_MINUTES`/`_DAYS` matching §6's prose:
the service does one multiplication for every purpose instead of three different ones, and a
mixed-unit set is how a `60` gets read as the wrong thing.

The invitation TTL is read by Task 15, not by anything here — so **make it reachable**: expose the
TTL lookup over all three kinds, and pin it with a spec asserting **every** `VerificationPurpose`
value in the Prisma enum has a TTL. That spec is also what turns red if Ruling 2 is ever violated.

**Cost if wrong:** a TTL nothing reads is dead weight (ruling 8 from Task 1 is the precedent), and
hard-coded TTLs cannot be shortened during an incident without a deploy.

### Ruling 9 — the redaction spec must attack the realistic shape, not the easy one

The plan asks for "a spec that runs the redacting logger over a token-carrying object and asserts
the value does not appear". Written the obvious way that spec proves nothing:
`SECRET_KEY_FRAGMENTS` in `packages/observability/src/redaction.ts:10-24` already contains
`token`, so `{ token: '…' }` is redacted **by key name** and would pass whatever the token looked
like.

The real leak path is the token inside a **verification URL under an innocent key** —
`verifyUrl`, `link`, `href` — and none of the five `SECRET_VALUE_PATTERNS` at `redaction.ts:31-37`
matches a bare base64url string.

**Measure it. Report exactly what happened, both ways.** If the token survives redaction under an
innocent key, the fix is bounded and belongs in this task: add one value pattern matching a
`token=`-style query parameter, and update the key list quoted in
`.claude/operations/monitoring.md` §2, which `redaction.ts:8` names as its source list. **Do not
redesign the logger.** Ship a spec covering both the key path and the URL path either way.

**Cost if wrong:** Task 5 builds that URL and Tasks 8/10 log around it. A leak found then is a
leak that already shipped, and the token in a log line is a password reset for anyone with log
access.

### Ruling 10 — the concurrency test is the deliverable, and it goes in `apps/api`

`apps/api/src/modules/auth/token.service.integration.spec.ts`. The `integration` project in
`vitest.workspace.ts` matches `apps/*/src/**/*.integration.spec.{ts,tsx}`, so the location is
already claimed — `pnpm check:specs` must still pass.

**Use the Testcontainers harness, not the compose stack.** This is the trap in this task. Every
existing `apps/api` integration spec reaches Redis or MinIO through the root `.env` and the running
compose stack, and **CI never applies migrations to that database** — `.github/workflows/ci.yml` brings
compose up (line 88) and goes straight to `pnpm test:integration` (line 92). A spec that inserts
into `VerificationToken` against the compose database passes on your machine and fails in CI with
"relation does not exist". `packages/db/src/testing/postgres-harness.ts` starts its own Postgres 16
**and runs `prisma migrate deploy`** (line 40), which is why every table-touching integration spec
in the repository uses it.

It is not exported yet. Add a `./testing` subpath to `packages/db/package.json`'s `exports`,
mirroring the `./unscoped` entry — `packages/db/dist/testing/postgres-harness.d.ts` already builds
and its emitted `.d.ts` references no Testcontainers type, so `apps/api` needs no new dependency.
Verify that claim rather than trusting this sentence.

The test itself: issue a token, then fire **two** redemptions of it in parallel with
`Promise.all`, and assert **exactly one** success and one refusal. Then prove the test can fail —
temporarily reimplement consumption as read-then-write, watch it go red, restore, and **put both
outputs in your report**. A concurrency test that has never failed has proven nothing.

Also cover, in integration: expiry (a token stamped in the past is refused), single use (a second
sequential redemption is refused), and supersession (issuing a second token for the same user and
purpose refuses the first).

## What "done" looks like

Every command below run, with its real exit code captured **outside a pipe**
(`out=$(pnpm <cmd> 2>&1); code=$?` — `$?` after a pipe reports the last stage, not the command):

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm check:specs` ·
`pnpm check:openapi` · `pnpm check:registry` · `pnpm build` · `pnpm test:integration`

`pnpm check:openapi` must still say **4 routes**. `pnpm check:registry` must still say **14
models**. `pnpm check:specs` must claim every new spec. `pnpm test:e2e` is **not** required — this
task cannot reach a rendered page — but say so in your report rather than omitting the row.

Docker Desktop must be running before `pnpm test:integration`.

Two things that are not optional: the raw token is returned to the caller **exactly once** and is
never stored, never logged, never returned again; and `TokenService` never receives a raw token it
then persists.

**Watch the word "token" — it means two different things in this module.**
`apps/api/src/modules/auth/auth.tokens.ts` holds **Nest DI injection tokens**
(`ARGON2_PARAMETERS`, …). Your service is about **secret credentials**. Do not add secret-token
constants to that file, and do not let a reader confuse the two — name things so the distinction
survives.

## Rules on what you write

From the plan's Execution protocol §3, and they are not negotiable:

- **Report commands and exit codes, not prose.** No status sentences, no "this now works".
- **Do not edit `roadmap.md`.** Do not write `.claude/` narrative. The only `.claude/` edits you
  are authorised to make are the mechanical ones named in Rulings 7 and 9, plus `.env.example`
  under Ruling 8.
- **Do not write or edit an ADR.** None is owed.
- Every factual claim in your report names the command, or the file and line, that establishes it.
  Verify before you assert — including when you are correcting something you said earlier. Four of
  Phase 1's twelve false claims were introduced *while correcting* an earlier one.

Documentation ships in the task that makes it false. If your change makes a sentence in
`.claude/security/authentication.md`, `.claude/api/errors.md` or `.claude/operations/monitoring.md`
untrue, **report it**; the orchestrator writes the replacement sentence.
