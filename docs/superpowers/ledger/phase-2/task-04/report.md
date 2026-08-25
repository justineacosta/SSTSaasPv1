> **A dated record of what was said and decided at the time. Not a description of current state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

# Phase 2 · Task 4 — implementer report

Dated 2026-08-26. Branch `feat/phase-2-task-04`, cut from `main` at `a0b1fc9`.
Head before this report was committed: `25363b4`. Nothing pushed.

## 1. Commands and exit codes

Every code captured outside a pipe (`out=$(pnpm <cmd> 2>&1); code=$?`). Counts are the
strings the command printed.

| # | Command | Exit | Printed counts |
|---|---|---|---|
| 1 | `pnpm format:check` | **0** | `All matched files use Prettier code style!` |
| 2 | `pnpm lint` | **0** | `Tasks:    14 successful, 14 total` |
| 3 | `pnpm typecheck` | **0** | `Tasks:    14 successful, 14 total` |
| 4 | `pnpm test` | **0** | `Test Files  53 passed (53)` · `Tests  643 passed (643)` |
| 5 | `pnpm check:specs` | **0** | `check:specs OK — 65 spec files, each claimed by exactly one of: unit, integration, ui. No banned .test.* spellings.` |
| 6 | `pnpm check:openapi` | **0** | `check:openapi OK — apps/api/openapi.json is byte-identical to what the contracts generate.` · the generator logged `"routes":4` |
| 7 | `pnpm check:registry` | **0** | `check:registry OK — 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global.` |
| 8 | `pnpm build` | **0** | `Tasks:    8 successful, 8 total` |
| 9 | `pnpm test:integration` | **INTERMITTENT — see §2** | passing run: `Test Files  12 passed (12)` · `Tests  161 passed (161)`; failing runs: `Tests  1 failed / 160 passed (161)` |
| 10 | `pnpm test:e2e` | **not run** | Not required by the brief, and not run. This task ships no route and no page — `check:openapi` still reports 4 routes — so there is nothing for Playwright to reach. |

`docker compose ps` at the time of the runs: `mailpit`, `minio`, `postgres`, `redis` all
`Up 2 hours (healthy)`.

Movement from the brief's Task 3 baseline:

| Metric | Task 3 baseline (brief) | This branch | Delta |
|---|---|---|---|
| `pnpm test` files / tests | 48 / 596 | 53 / 643 | +5 / +47 |
| `pnpm check:specs` spec files | 59 | 65 | +6 |
| `pnpm test:integration` files / tests | 11 / 148 | 12 / 161 | +1 / +13 |
| `pnpm check:openapi` routes | 4 | 4 | 0 — as the brief required |
| `pnpm check:registry` models | 14 | 14 | 0 — as the brief required |

## 2. `pnpm test:integration` is intermittent on this machine, and this branch is implicated

**This is the one thing in this report that is not green, and I could not close it.**

Eight runs of `pnpm test:integration` on this branch:

| Run | Exit | Result |
|---|---|---|
| 1 | 1 | `1 failed / 160 passed (161)` |
| 2 | 0 | `161 passed (161)` |
| 3 | 1 | `1 failed / 160 passed (161)` |
| 4 | 0 | `161 passed (161)` |
| 5 | 0 | `161 passed (161)` |
| 6 | 1 | `1 failed / 160 passed (161)` |
| 7 | 0 | `161 passed (161)` |
| 8 | 1 | `1 failed / 160 passed (161)` |

Every failure is in `apps/api/src/common/guards/sliding-window.integration.spec.ts`, in one
of two tests, and always as a count that came back lower than written:

- `consumeSlidingWindow > does not charge a refused request against the window` —
  `expected 1 to be 2` (run 1), `expected +0 to be 2` (run 3)
- `consumeSlidingWindow > admits exactly 'limit' of many genuinely concurrent requests` —
  `expected +0 to be 5` (run 6)

**`apps/api/src/modules/auth/token.service.integration.spec.ts` passed all 13 of its tests in
all eight runs.** No failure was ever in code this branch wrote.

What I established, each by command:

- **The file and its subject are untouched by this branch.** `git diff main...HEAD --name-only`
  lists 22 files, none under `apps/api/src/common/guards/`.
  `git log --oneline main..HEAD -- apps/api/src/common/guards/` prints nothing. The spec was
  last changed at `4ec76a0` (2026-08-21).
- **The suite is green without my spec.** `pnpm vitest run --project integration --exclude
  "**/token.service.integration.spec.ts"` — 3 runs, all exit 0, `148 passed (148)`, which is
  exactly the brief's Task 3 baseline.
- **The guard specs are green on their own.** `pnpm vitest run --project integration
  apps/api/src/common/guards/` — 4 runs, all exit 0, `36 passed (36)`.
- **Eviction is not the mechanism.** `redis-cli config get maxmemory` → `0`;
  `config get maxmemory-policy` → `noeviction`; `info stats` → `evicted_keys:0`.
- **TTL expiry from clock drift is not the mechanism.** The Lua at
  `apps/api/src/common/guards/sliding-window.ts:76` does `PEXPIRE key windowMs`. I set a
  `clockprobe` key with `PX 60000` and polled `PTTL` 60 times while `pnpm test:integration` ran
  in the background. PTTL fell 59209 → 19359 (39850 ms) while host `Date.now()` moved
  1787678927202 → 1787678967058 (39856 ms) — agreement to ~6 ms over 40 s, no jump, no early
  expiry. That run still failed (`1 failed / 160 passed`).
- **Resource contention is visible.** The new spec's own reported duration ranged from `5399ms`
  (run in isolation) to `17837ms` (run inside the full suite), and its container start is the
  only new Docker workload in the run.

So: the correlation with this branch is real and I am not claiming otherwise, but I could not
identify the mechanism, and the two hypotheses I could test are both disproved. **This is a CI
risk and it is unresolved.** I did not touch the flaking spec.

## 3. What was built

| File | Status |
|---|---|
| `apps/api/src/modules/auth/secret-token.ts` | new — Layer 1 primitive (Ruling 1) |
| `apps/api/src/modules/auth/secret-token.spec.ts` | new — 5 tests |
| `apps/api/src/modules/auth/token.service.ts` | new — Layer 2 `VerificationToken` persistence |
| `apps/api/src/modules/auth/token.service.spec.ts` | new — 14 tests |
| `apps/api/src/modules/auth/token.service.integration.spec.ts` | new — 13 tests (Ruling 10) |
| `apps/api/src/modules/auth/token-invalid.error.ts` | new — 422 `TOKEN_INVALID` (Ruling 7) |
| `apps/api/src/modules/auth/token-invalid.error.spec.ts` | new — 4 tests |
| `apps/api/src/modules/auth/token.redaction.spec.ts` | new — 4 tests (Ruling 9) |
| `apps/api/src/modules/auth/auth.tokens.ts` | edited — `SECRET_TOKEN_TTL_SECONDS` at line 18 |
| `apps/api/src/modules/auth/auth.module.ts` | edited — `imports: [PrismaModule]`, TTL factory, `TokenService` |
| `apps/api/src/modules/auth/auth.module.spec.ts` | edited — `PRISMA` override, TTL assertions |
| `apps/api/openapi.json` | regenerated — one line, `"TOKEN_INVALID"` |
| `packages/contracts/src/error-codes.ts` | edited — `TOKEN_INVALID` at line 39 |
| `packages/contracts/src/error-codes.spec.ts` | new — 6 tests (Ruling 27) |
| `packages/config/src/env.ts` | edited — three TTLs at lines 92, 93, 99 |
| `packages/config/src/env.spec.ts` | edited — 8 tests added |
| `packages/db/package.json` | edited — `"./testing"` export at line 17 |
| `packages/db/src/index.ts` | edited — `datamodelEnums` / `DatamodelEnum` exported |
| `packages/observability/src/redaction.ts` | edited — one value pattern at line 62 (Ruling 9) |
| `packages/observability/src/redaction.spec.ts` | edited — 4 tests added |
| `.claude/api/errors.md` | edited — §3 Validation line, line 84 (Ruling 7) |
| `.env.example` | edited — TTL block (Ruling 8) |

Commits on the branch, oldest first: `949c757`, `7658dbd`, `1cb8f28`, `7198550`, `25363b4`.

## 4. Ruling 9 — the redaction measurement, reported both ways

**The token survived redaction under an innocent key. The gap was real.**

`apps/api/src/modules/auth/token.redaction.spec.ts` runs `createLogger` from
`@sentinel/observability` over a token from `mintSecretToken()` in four shapes and asserts the
raw value does not appear in the emitted line. Before any change to `redaction.ts`:

```
 Test Files  1 failed (1)
      Tests  3 failed | 1 passed (4)
```

| Shape | Before the fix |
|---|---|
| `{ token }` — denylisted key | **redacted** (passed) |
| `{ verifyUrl: 'https://app.sentinel.test/auth/verify?token=<43 chars>' }` | **leaked** |
| token inside the `msg` string | **leaked** |
| token as a trailing `%s` interpolation argument | **leaked** |

The emitted lines, from the captured failure output:

```
{"level":"info",...,"verifyUrl":"https://app.sentinel.test/auth/verify?token=JFqAQ3-_L-BSZrsbVpMUdX2rKzyHxz3tLix6eb-2_U0","msg":"verification email queued"}
{"level":"info",...,"msg":"sending https://app.sentinel.test/auth/reset?token=U32c2rxRXTfuTolNBJYdL332nOS0FeOSg4myYEwQ17k to the mailer"}
{"level":"info",...,"msg":"reset link: https://app.sentinel.test/auth/reset?token=r0sSNA1eA-BMjtswzEyjuArFiIEtzlnh_fxXo1tPwWs"}
```

This is exactly the brief's prediction: `SECRET_KEY_FRAGMENTS` contains `token`, so the
key-name case was already covered and proves nothing; none of the five
`SECRET_VALUE_PATTERNS` matched a bare base64url value.

**Fix, as the ruling scoped it:** one value pattern added to `SECRET_VALUE_PATTERNS`
(`packages/observability/src/redaction.ts:62`), matching a credential-named URL query or
fragment parameter, with an 8-character floor as the false-positive guard. Written as a
lookbehind so `redactSecretsInText` replaces only the value and the route stays readable;
`redact()` still replaces the whole structured field. The logger was not redesigned.

After:

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Four tests added to `packages/observability/src/redaction.spec.ts`, including the
false-positive control: `?status=RUNNING&limit=50`, `?code=US` (under the 8-character floor)
and `?tokenize=please-do-not-redact-me` are all left byte-identical.

**One deviation from Ruling 9, stated rather than done quietly.** The ruling said to "update
the key list quoted in `.claude/operations/monitoring.md` §2". I did not, because the fix
changed no key. §2 at `monitoring.md:28-30` reads: *"redacts by key name (`password`, `token`,
`secret`, `key`, `authorization`, `cookie`, `apiKey`, `mfaSecret`) plus value-shape heuristics
as a backstop."* `SECRET_KEY_FRAGMENTS` is unchanged, and §2 does not enumerate the value-shape
heuristics, so no sentence in it became false. Editing the key list would have documented a
change that did not happen. **The orchestrator should rule on whether §2 now wants a sentence
naming the URL-parameter backstop; that is prose, and prose is not mine to write.**

For the record, a pre-existing mismatch I did not touch: §2 lists a bare `key`, and
`SECRET_KEY_FRAGMENTS` has `apikey` and `privatekey` but no bare `key`. That predates this task.

## 5. Ruling 10 — the concurrency test, red then green

Both outputs, as required.

**Red.** `consume` temporarily reimplemented as read-then-write (`findUnique`, check
`consumedAt` / `expiresAt` / `purpose` in application code, then `updateMany`):

```
   ✓ issuing a token > stores only the hash — the database cannot mint a valid token 13ms
   ✓ issuing a token > stamps the expiry from the purpose TTL, in the database 8ms
   ✓ consuming a token > accepts a valid token once and reports whose it was 15ms
   ✓ consuming a token > refuses the second sequential redemption of the same token 14ms
   ✓ consuming a token > refuses an expired token 12ms
   ✓ consuming a token > refuses a token that never existed 2ms
   ✓ consuming a token > refuses a token presented for the wrong purpose 11ms
   ✓ supersession > invalidates the previous token of the same purpose when a new one is issued 11ms
   ✓ supersession > leaves the same user's other purpose alone 13ms
   ✓ supersession > leaves another user's token of the same purpose alone 14ms
   × two concurrent redemptions of one reset link > produces exactly one success and one refusal 32ms
     → expected [ { …(3) }, { …(3) } ] to have a length of 1 but got 2
   × two concurrent redemptions of one reset link > holds across a wider burst 41ms
     → expected [ { …(3) }, { …(3) }, { …(3) }, …(5) ] to have a length of 1 but got 8
   ✓ two concurrent redemptions of one reset link > lets two different tokens through concurrently — the lock is per row 24ms

 Test Files  1 failed (1)
      Tests  2 failed | 11 passed (13)
```

Exit 1. **All eleven sequential tests stayed green under the wrong implementation.** Two
concurrent redemptions of one password-reset link both succeeded; a burst of eight all
succeeded.

**Green.** Restored (`git diff --stat` on the file: empty, i.e. identical to the committed
version), same command:

```
 ✓  integration  apps/api/src/modules/auth/token.service.integration.spec.ts (13 tests) 5399ms

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

Exit 0.

The third concurrency test is a negative control: two *different* tokens redeemed in parallel
must both succeed. Without it, an implementation that took a global lock and only ever
succeeded once would pass the first two tests.

**On the brief's Testcontainers claim — verified, not trusted.**
`packages/db/dist/testing/postgres-harness.d.ts` matched zero of
`testcontainers|Testcontainers|StartedPostgreSqlContainer` (`grep -c` = 0), and
`grep -c testcontainers apps/api/package.json` = 0. `"./testing"` added to
`packages/db/package.json:17` mirroring `"./unscoped"`; `apps/api` needed no new dependency and
`pnpm typecheck` is exit 0.

## 6. Ruling 27 — the error-code parity spec, proven red on each side

Built. `packages/contracts/src/error-codes.spec.ts` extracts every backticked
`SCREAMING_SNAKE` token from `.claude/api/errors.md` §3 and compares it to `ERROR_CODES` in
both directions. §3's markdown yielded a robust extraction — the section contains no backticked
upper-case text that is not a code — so it shipped rather than being reported as an honest gap.

Proven to fail by mutation, each restored afterwards:

| Mutation | Exit | Failing test |
|---|---|---|
| `MUTANT_CODE` added to `error-codes.ts` only | 1 | `documents every registered code` — `expected [ 'MUTANT_CODE' ] to deeply equal []` |
| `MUTANT_CODE` added to `errors.md` §3 only | 1 | `registers every documented code` — `expected [ 'MUTANT_CODE' ] to deeply equal []` |
| `## 3. Codes` renamed to `## 3. Error codes` | 1 | collection error: `errors.md has no "## 3. Codes" heading.` |
| restored | 0 | `Tests  6 passed (6)` |

The third mutation guards the failure mode this repository keeps hitting: a reshaped document
would otherwise make the extraction return `[]` and every set comparison pass. The spec also
asserts a floor of 30 extracted codes and the presence of `**Validation:**`.

## 7. Rulings 1–8, as implemented

- **Ruling 1 — two layers.** `secret-token.ts` is the primitive (`mintSecretToken`,
  `hashSecretToken`), a pure function of `node:crypto` touching no table; `token.service.ts` is
  `VerificationToken` persistence. Task 6 and Task 15 call the primitive and write their own rows.
- **Ruling 2 — no enum value, no migration.** `pnpm check:registry` still prints `14 models`. No
  file under `packages/db/prisma/migrations/` was added or edited.
- **Ruling 3 — the count is the decision.** One `updateMany` with
  `{ tokenHash, purpose, consumedAt: null, expiresAt: { gt: now } }`, accepted at
  `apps/api/src/modules/auth/token.service.ts:234` (`if (count !== 1) return null;`).
  **I placed the `userId` lookup *after* the winning update** (`token.service.ts:236`) rather
  than before it as a hint. The ruling permits a before-read and does not require one; reading
  after makes it structurally impossible for the read to become the gate, and it cannot be stale
  because `tokenHash` is `@unique` and the row was just consumed by this request. A `null` there
  fails closed rather than inventing a `userId`. Flagged because it is a deviation in shape.
- **Ruling 4 — the API process clock.** `new Date()` both stamps `expiresAt` at issue and is
  compared at consume. A unit test asserts the instant written into `consumedAt` is the same
  value compared against `expiresAt`.
- **Ruling 5 — supersession sets `consumedAt`.** `issue` runs `updateMany` then `create` inside
  one `$transaction`, in that order; a unit test asserts the order and that both calls were
  inside the transaction. No new column, no migration.
- **Ruling 6 — no `AuditEvent` here.** Nothing in this task writes one. **Carry-forward for
  Tasks 8, 10 and 15: the audit event is yours to write, and the raw token never enters
  `metadata`.**
- **Ruling 7 — one code.** `TOKEN_INVALID` at `packages/contracts/src/error-codes.ts:39` and
  `.claude/api/errors.md:84`. `TokenInvalidError` extends `DomainError`, status 422, no
  `details` field at all (a reason would itself be the oracle). Its spec asserts the rendered
  message and details contain none of `expire`, `consum`, `used`, `supersede`, `unknown`,
  `exist`, `found`, and nothing matching `[A-Za-z0-9_-]{20,}`. Nothing raises it yet.
- **Ruling 8 — three TTLs, seconds, base object.** `packages/config/src/env.ts:92-99`, inside
  `apiEnvObject`, before the `.superRefine` (carry-forward ruling 30). All defaulted, so nothing
  existing has to change to boot. `.env.example` carries the human-readable value beside each
  number — **verified the inline comments parse**: `dotenv@16.6.1` yields bare `86400` / `3600`
  / `604800`, which matters because CI copies that file to `.env`. The invitation TTL is
  reachable through `TokenService.ttlSecondsFor('INVITATION')` and asserted in
  `auth.module.spec.ts`. The completeness spec reads `datamodelEnums()` and asserts every Prisma
  `VerificationPurpose` value has a TTL — that is the spec that turns red if Ruling 2 is ever
  violated.

## 8. The two things the brief called non-optional

- **The raw token is returned exactly once and never stored.** `issue` returns
  `IssuedToken.token`; the row holds only the SHA-256 hex. Asserted three ways: a unit test
  stringifies *every* recorded store call and asserts it does not contain the raw token; the
  integration test stringifies the persisted row and asserts the same; the redaction spec
  asserts it does not survive a log line in four shapes.
- **`TokenService` never receives a raw token it then persists.** `consume` takes the raw token,
  hashes it before any store call, and a unit test asserts the literal `'a-raw-token'` appears
  in no recorded call.

## 9. Things a reviewer should look at

1. **§2's intermittent integration suite.** The most important item in this report.
2. **A false green I introduced and then caught.** The first version of
   `token-invalid.error.spec.ts` asserted `expect(error.code).toBe(ERROR_CODES.TOKEN_INVALID)`
   and passed while the constant did not exist in `@sentinel/contracts`' build — both sides read
   `undefined`. Confirmed by `grep -n TOKEN_INVALID packages/contracts/dist/error-codes.js`
   returning only `CSRF_TOKEN_INVALID`. The spec now asserts the literal first, and was re-run
   against the stale build to prove it goes red (`expected undefined to be 'TOKEN_INVALID'`,
   exit 1) before rebuilding. Same shape as Task 2's and Task 3's Medium findings; there may be
   more of it in specs I wrote.
3. **`packages/db/src/index.ts` now exports `datamodelEnums`.** Additive, needed by the TTL
   completeness spec in `apps/api`. Nothing it exports can open a connection.
4. **The read-after-update in `consume`** (Ruling 3 deviation, §7).
5. **`auth.module.spec.ts` now overrides `PRISMA`** rather than letting `PrismaModule`'s factory
   build a real client. The stub needed `$connect`/`$disconnect` no-ops — `PrismaLifecycle`'s
   shutdown hook runs on `moduleRef.close()`, measured as
   `TypeError: this.prisma.$disconnect is not a function` without them.
6. **`SECRET_TOKEN_TTL_SECONDS` lives in `auth.tokens.ts`.** The brief said not to add
   secret-token constants to that file. I read that as excluding the constants of the
   secret-token domain (byte lengths, TTL numbers), which live in `secret-token.ts` and
   `packages/config`. What went into `auth.tokens.ts` is a Nest DI key, which is the only thing
   that file holds, and its docblock now states the two senses of "token" explicitly. If the
   orchestrator reads the ruling more strictly, this is the line to move.

## 10. Documentation

No sentence in `.claude/security/authentication.md`, `.claude/api/errors.md` or
`.claude/operations/monitoring.md` was made untrue by this change, as far as I could establish.
The only `.claude/` edit made is `.claude/api/errors.md:84` (Ruling 7's mechanical list edit),
plus `.env.example` under Ruling 8. `roadmap.md` untouched. No ADR written or edited. §4 records
the one place where the orchestrator may want to add a sentence to `monitoring.md` §2, and why I
did not add it myself.
