# Phase 2 · Task 6 — Session service · implementer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch. Plan section: Task 6 in
[`../../../plans/2026-08-24-phase-2-identity.md`](../../../plans/2026-08-24-phase-2-identity.md).
Branch: `feat/phase-2-task-06`, cut from `main` at `2fceaaa`.

**You are the chained implementer for Tasks 6 and 7.** The plan's execution protocol §2 puts
6→7 in one implementer's hands because the authentication guard inherits this task's shapes and a
cold agent re-invents conventions rather than inheriting them. Build Task 6 only. Do not start
Task 7, do not build a guard, and do not read a cookie off a request anywhere in this task — but
design the surface you leave behind knowing you are the one who will consume it.

## What you are building

`SessionService` — issue, resolve, rotate, revoke — with a Redis cache in front of the lookup and
a Postgres fallback behind it, plus the cookie serialisation Task 7 will attach to a response.

**You are not building an endpoint and not building a guard.** Nothing in this task is reachable
over the network. `pnpm check:openapi` must still report **4 routes** when you are finished, and
that check is the proof you did not ship a route. `AuthModule` gains a fourth service and still
registers no controller.

## Deliverables

1. **`apps/api/src/modules/auth/session.service.ts`** — the policy: lifetimes, rotation,
   revocation, rolling renewal, cache invalidation.
2. **`apps/api/src/modules/auth/session.repository.ts`** — the Postgres access. Follow
   `TokenService`'s narrow-port shape: declare the slice of Prisma you use as an interface rather
   than taking `PrismaClient`, so a unit spec supplies a recording double instead of mocking the
   world.
3. **`apps/api/src/modules/auth/cookies.ts`** — the cookie name and attributes as one authority,
   with a serialiser and a clearer. Pure functions over strings; no `Request`, no `Response`.
4. **Unit specs** for lifetime arithmetic, renewal thresholds, cookie attributes, and cache-key
   construction.
5. **Integration specs** against a real Postgres and the compose Redis for: revocation immediacy,
   the two lifetimes independently, rotation under concurrency, and the Redis-down fallback.
6. **Environment variables** for the four lifetimes and the cache TTL, in `apiEnvSchema`, with
   `.env.example` updated.
7. **`.claude/security/authentication.md` §3** updated — see _Doc ownership_.

## The behaviour, from `security/authentication.md` §3 and ADR-0005

Read both before you write anything. The plan's checklist is the same content in imperative form;
where the plan and the security document differ, the security document wins and you say so in your
report.

- **256-bit token, SHA-256 hash stored.** Reuse `mintSecretToken()` and `hashSecretToken()` from
  `secret-token.ts` — that file's own docblock names this task as a caller. Do not mint your own
  bytes and do not reach for Argon2id; the reasoning for SHA-256 over a 256-bit CSPRNG value is
  written there and applies unchanged.
- **Two lifetimes, two columns, two independent tests.** `absoluteExpiresAt` is 7 days, 30 with
  remember-me, and **never moves**. `idleExpiresAt` is 24h from `lastSeenAt` and moves forward on
  use. The schema comment on `Session` says exactly why they are separate columns; a test that
  proves only one of them is the failure mode it describes. One test must expire a session by the
  absolute clock while the idle clock is fresh, and another must do the reverse.
- **Rolling renewal past the halfway mark of the idle window, not on every request.** A write to
  Postgres on every authenticated read is the thing this rule exists to avoid. The threshold is a
  pure function and belongs in a unit spec.
- **Rotation on every privilege change** — login, MFA completion, password change, role change.
  Rotate means: issue a new row, mark the old one rotated, set `rotatedFromId` on the new one.
  This is the session-fixation defence and the test names it as such.
- **Revocation deletes the cache entry and the row together, in that order.** The order is the
  control: delete the row first and a concurrent request can repopulate the cache from a read that
  raced the delete. The test that matters is the immediacy one — resolve a session, revoke it, and
  assert the *very next* resolve is a refusal. This is one of the three Phase 2 exit criteria and
  it is the one most easily satisfied only eventually.
- **Redis unavailable falls back to Postgres, not to a failure.** ADR-0005 promises this in its
  Consequences section. Test it by pointing a client at a dead port — the sliding-window
  integration spec already has the shape for that.
- **`revokeAllForUser(userId, { except })` and `revokeAllForUserInOrganization(userId, orgId)`.**
  Password change and reset need the first (§2); member removal needs the second
  (`permissions.md` invariant 5). Both must clear every affected cache entry, which means you need
  to be able to enumerate a user's live sessions — the `@@index([userId, lastSeenAt(sort: Desc)])`
  on `Session` exists for this and for `/settings/security`'s list.
- **`ip` and `userAgent` are recorded, and `userAgent` is user-controlled input.** Length-cap it at
  the boundary where it is written. It reaches a browser in Task 17's session list, so it is also
  the one field in this table an attacker chooses.

## Rulings taken before dispatch

A ruling is a floor, not a ceiling. If you find a better answer, take it and say so in your report
with the reason. What you may not do is silently ignore one.

**Ruling 6 — `Session.status` has no `@default`, and that is a security control.** Every
`session.create` states its status explicitly, so forgetting is a compile error rather than a
silently privileged session. A session created by login before MFA is `PENDING_MFA`; one created
for a user with no confirmed factor is `ACTIVE`. **Do not add a default** to the schema to make
your code tidier.

**Ruling 31 — a supersede-then-insert pair against a non-unique index needs an advisory lock, and
you must decide whether rotation is that shape.** `TokenService.issue` holds
`pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` as the first statement in its
transaction because under READ COMMITTED a second transaction cannot see the first's uncommitted
INSERT — measured at ten live-token pairs out of ten before the lock existed. Rotation looks like
the same shape and may not be: it supersedes **one known row by primary key**, which is a unique
index, so an affected-row-count decision (`updateMany` where the row is still live, then `count`
decides) may already serialise it the way `TokenService.consume` does. **Decide which, and prove
it by measurement rather than by argument.** The property to fire two parallel rotations at: one
session credential rotated twice concurrently must yield **exactly one** live successor, never
two. Two live sessions from one credential is a session-fixation defence that does not defend.

**Ruling 33 — the integration suite runs sequentially and shares one compose Redis.** Namespace
every session cache key under a prefix nothing else uses, and **never `FLUSHALL` or `FLUSHDB`** in
a spec: the rate-limit specs live in the same instance and one of them already deletes its own
namespace in a `beforeEach`. Delete the keys you created, by key. Do not restore file
parallelism.

**Ruling 30 — `apiEnvSchema` is a `ZodEffects`.** `.extend()`, `.partial()`, `.merge()` and
`.shape` are unavailable on it. Add your variables **inside the base object, before the
refinement**. `pnpm typecheck` catches a mistake here.

**Ruling 32 does not land on you, and this is deliberate.** The partial unique index on
`VerificationToken(userId, purpose) WHERE consumedAt IS NULL` is owed by "whichever task next
opens a migration". **Task 6 opens no migration**: `Session` already carries `tokenHash @unique`,
both lifetime columns, `status`, `rotatedFromId`, `revokedAt`, `lastSeenAt`, `ip`, `userAgent`,
`rememberMe`, `mfaCompletedAt`, `activeOrganizationId` and both indexes, all from Task 1. If you
believe you need a schema change, **stop and report it before making one** — it changes who owns
ruling 32 and it needs the operator's SQL review under the plan's protocol §5.

**Ruling 39 — an agent that mutates `schema.prisma` must run `prisma generate` after reverting.**
`packages/db/generated/` is untracked, so a clean `git status` is not evidence that a mutation was
undone.

**Ruling 40 — `pnpm test` and `pnpm lint` can both be green while `pnpm typecheck` is not.** Run
all three.

**Rulings 37 and 38 are not yours but constrain your surface.** `TokenService` writes no
`AuditEvent` and checks no `User.status`; the endpoint does both. `SessionService` is the same
kind of object: it does not decide whether a user is allowed to have a session, it mints one when
told to. **Do not put a `User.status` check inside `issue`** — Task 9 owns refusing a `LOCKED`
user, and burying it here would give Task 9 two places to look and one of them silent.

## The `__Host-` prefix measurement, and why it is a deliverable

The plan makes this an explicit precondition: **verify that a `__Host-` prefixed cookie is
actually accepted over `http://localhost` in a real Chromium before building on it.** Browsers
treat localhost as a trustworthy origin and so accept `Secure` there, but "so it should work" is
the class of assumption this project's honesty rule exists to refuse. If it does not hold, every
E2E test in Task 18 fails for a reason that looks like an application bug, and finding that out in
Task 18 costs ten times what finding it out now costs.

No route exists to set the cookie, so this is a **measured probe, not a committed spec**: a
throwaway HTTP server that sends your exact `Set-Cookie` header, a real Chromium, and a read of
the cookie jar afterwards. Playwright and its Chromium are already installed for `apps/web`'s E2E
suite. Put the script in the scratchpad, run it, and paste the **observed output verbatim** into
your report along with the Chromium version. Report the negative result just as plainly if that is
what you measure.

## Prose rules — review-blocking

Phase 1's recurring defect was not bad code. It was **false factual claims in written prose: 12
instances, 5 of them introduced while correcting an earlier one.** Phase 2 has added six more,
including a false rationale written beside a correct decision and a citation to a document string
that does not exist.

- **Report commands and exit codes. Do not write status prose.** No "this now works", no summary
  paragraph, no `roadmap.md` edit, no `.claude/` narrative beyond the one document named below.
  Raw evidence goes up; the orchestrator writes every sentence that asserts anything.
- **Every claim carries its source** — the command and its exit code, or the file path and the
  line you read. Do not cite a document section without opening it. Do not state a number you did
  not measure. A performance figure, a timing, a row count and a "browsers do X" are all claims.
- **A decision can be right while the reason written beside it is false, and the false reason is
  still a defect** (ruling 22). Every comment you write explaining *why* is subject to the same
  standard as the code.
- Capture exit codes outside a pipe: `out=$(pnpm test 2>&1); code=$?`. After a pipe, `$?` reports
  the last stage.

## Doc ownership

**`.claude/security/authentication.md` §3 only.** Its "Status: Designed. Not Implemented" banner
becomes false for sessions in this task. Update the banner to name exactly what is built and what
is not — the service exists and is proven; no endpoint issues a session, no guard reads one, and
no cookie has ever reached a browser. Touch no other `.claude/` document: §4 (CSRF),
`api/authentication.md` §3 and `abuse-prevention.md` all belong to Task 7, and
`architecture/backend.md`'s pipeline gains its live stages there too.

## Verify

Run all of these on the finished tree and report each with its real exit code:

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`, `docker compose ps`.

`pnpm test:e2e` is not expected — this task touches no `apps/web` path. If you touch one, it
becomes required and you say why you touched it.

**Name the revocation-immediacy test explicitly in your report**, by file and test name, with the
output of the run that proves it. The plan singles it out because it is a phase exit criterion.

Report the before/after test counts (`pnpm test` was **61 files / 847 tests** and
`pnpm test:integration` **13 files / 169 tests** on `main` at `2fceaaa`, verified by the
orchestrator on 2026-08-26 before dispatch).

Commit frequently on `feat/phase-2-task-06` with conventional-commit messages. Do not commit to
`main`. Do not open a pull request.
