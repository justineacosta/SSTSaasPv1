> **A dated record of what was said and decided at the time. Not a description of current state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

# Phase 2 · Task 4 — adversarial review

Dated 2026-08-26. Reviewer session, fresh, did not write the code.
Branch `feat/phase-2-task-04` at `1f8f700`; baseline `94c681c` (the brief commit) and `main` at
`a0b1fc9`. Working tree was clean at the start of this review and is clean at the end apart from
this file — every mutation described below was reverted and `git status --porcelain` verified empty
after each.

---

## Part 1 — the citation pass

Every factual claim in [`report.md`](report.md) re-checked against the repository. I ran each
command myself with the exit code captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`), and opened each file at the cited line.

### 1.1 The command table (report §1)

Run on this machine against `1f8f700`, Docker Desktop up, `docker compose ps` showing `mailpit`,
`minio`, `postgres`, `redis` all `Up 3 hours (healthy)`.

| # | Command | Report says | I measured | Verdict |
|---|---|---|---|---|
| 1 | `pnpm format:check` | 0, `All matched files use Prettier code style!` | exit 0, same string | **true** |
| 2 | `pnpm lint` | 0, `Tasks:    14 successful, 14 total` | exit 0, same string | **true** |
| 3 | `pnpm typecheck` | 0, `Tasks:    14 successful, 14 total` | exit 0, same string | **true** |
| 4 | `pnpm test` | 0, `Test Files 53 passed (53)` · `Tests 643 passed (643)` | exit 0, `53 passed (53)` / `643 passed (643)` | **true** |
| 5 | `pnpm check:specs` | 0, `65 spec files` | exit 0, `check:specs OK — 65 spec files, each claimed by exactly one of: unit, integration, ui.` | **true** |
| 6 | `pnpm check:openapi` | 0, generator logged `"routes":4` | exit 0, `{"routes":4,...}` then `check:openapi OK — apps/api/openapi.json is byte-identical…` | **true at HEAD** — see M1, it is *not* true at four of the branch's six commits |
| 7 | `pnpm check:registry` | 0, `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` | exit 0, same string verbatim | **true** |
| 8 | `pnpm build` | 0, `Tasks:    8 successful, 8 total` | exit 0, same string | **true** |
| 9 | `pnpm test:integration` | intermittent, 4 of 8 runs red | 6 runs: **4 green (exit 0), 2 red (exit 1)**; green runs `12 passed (12)` / `161 passed (161)` | **true in substance**, but the *characterisation* of the failures is incomplete — see L4 |
| 10 | `pnpm test:e2e` | not run, not required | I did not run it either. Correct: the task ships no route (`routes:4` unchanged) and no page, so Playwright has nothing to reach | **true** |

The delta table in report §1 (48/596 → 53/643 unit, 59 → 65 spec files, 11/148 → 12/161
integration, openapi 4 → 4, registry 14 → 14) is arithmetically consistent with the numbers I
measured and with the Task 3 baseline the brief records. **No false number found in report §1.**

### 1.2 File-and-line claims (report §3, §7)

Every one checked by `grep -n` / `sed -n`.

| Claim | Verdict |
|---|---|
| `SECRET_TOKEN_TTL_SECONDS` at `auth.tokens.ts:18` | **true** |
| `TOKEN_INVALID` at `packages/contracts/src/error-codes.ts:39` | **true** (`CSRF_TOKEN_INVALID` is at 12; they are distinct) |
| `.claude/api/errors.md:84` | **true** — `` `PASSWORD_BREACHED`, `TOKEN_INVALID`. `` |
| TTLs at `packages/config/src/env.ts:92, 93, 99` | **true** |
| TTLs are inside `apiEnvObject`, before the `.superRefine` (carry-forward ruling 30) | **true** — `apiEnvObject` spans lines 18–100, `.superRefine` is at line 123 |
| `"./testing"` export at `packages/db/package.json:17` | **true** |
| redaction value pattern at `packages/observability/src/redaction.ts:62` | **true** |
| `if (count !== 1) return null;` at `token.service.ts:234` | **true** |
| `findUnique` after the update at `token.service.ts:236` | **true** |
| `opaqueTokenSchema` unchanged | **true** — `packages/contracts/src/auth.ts:56`, `z.string().min(1).max(512)`, and `git diff main...1f8f700 -- packages/contracts/src/auth.ts` is empty |
| No file under `packages/db/prisma/migrations/` added or edited | **true** — `git diff main...1f8f700 --name-only -- packages/db/prisma/` prints nothing |
| Commits on the branch, oldest first: `949c757`, `7658dbd`, `1cb8f28`, `7198550`, `25363b4` | **true as a list of the five pre-report commits**, but see M1: `apps/api/openapi.json` is listed in report §3's "what was built" table and is in **none** of those five |

### 1.3 Quoted document sentences

This is the defect class the phase keeps hitting, so each quotation was `grep`ed as a literal
string against the document it is attributed to.

- Report §4 quotes `.claude/operations/monitoring.md` §2 as: *"redacts by key name (`password`,
  `token`, `secret`, `key`, `authorization`, `cookie`, `apiKey`, `mfaSecret`) plus value-shape
  heuristics as a backstop."* — **verbatim and correctly located**, `monitoring.md:29-30`, inside
  §2 (heading at line 15, §3 at line 35). The report's citation of "`monitoring.md:28-30`" for the
  surrounding passage is right: line 28 begins *"**Redaction is structural, not a regex over the
  final string.** The serialiser has an allowlist"*.
- Report §4's *"a pre-existing mismatch I did not touch: §2 lists a bare `key`, and
  `SECRET_KEY_FRAGMENTS` has `apikey` and `privatekey` but no bare `key`"* — **true**.
  `redaction.ts:10-24` contains `apikey`, `api_key`, `privatekey`, `private_key` and no bare `key`.
- Report §7's citation of `security/authentication.md` §6 for 24h / 1h / 7d — **true**,
  `authentication.md:99-112`, and §6's phrase *"invalidated by use or by a newer token"* is
  verbatim at line 102. §6's *"Response is identical whether or not the address exists"* is at
  line 108 as a table cell, which is how ruling 7 and `token-invalid.error.ts` use it. Correct.
- Report §7's *"the reason written above the password block at `env.ts:44-47`"* for API-only
  placement — the reasoning exists and the placement matches. Correct.

**No invented quotation, no misattributed sentence, no fabricated line number.** That is now two
tasks running with a clean citation pass on documents.

### 1.4 Claims about the intermittent suite (report §2)

| Claim | Verdict |
|---|---|
| `git diff main...HEAD --name-only` lists 22 files, none under `apps/api/src/common/guards/` | **true at `25363b4`, the head the report names.** I get 22 at `25363b4` and 24 at `1f8f700`; the extra two are `report.md` and `openapi.json`, both added by the report commit. The "none under guards" half is true at both. |
| `git log --oneline main..HEAD -- apps/api/src/common/guards/` prints nothing | **true** (0 lines) |
| The flaking spec was last changed at `4ec76a0` (2026-08-21) | **true** — `4ec76a0 2026-08-21 fix(api): bound the resend class by IP, and make three guarantees testable` |
| `148 passed (148)` without the new spec, matching the Task 3 baseline | **consistent** — 161 − 13 = 148, and 148 is the brief's recorded baseline. I did not re-run the exclusion; I am reporting this as arithmetically consistent, not as independently measured. |
| "Every failure is in `apps/api/src/common/guards/sliding-window.integration.spec.ts`" | **not true of my sample** — see L4 |

### 1.5 Claims I could not re-verify

- Report §9.2's *"`grep -n TOKEN_INVALID packages/contracts/dist/error-codes.js` returning only
  `CSRF_TOKEN_INVALID`"* describes a **stale build state that no longer exists** — `dist/` is
  rebuilt by `pnpm build:packages`, which every relevant command runs first. Unverifiable after the
  fact, and it is a self-reported catch rather than a claim anything rests on. I confirmed the fix
  is real by reading `token-invalid.error.spec.ts:20-21`, which asserts the string literal
  `'TOKEN_INVALID'` on both `error.code` and `ERROR_CODES.TOKEN_INVALID` — so both sides reading
  `undefined` can no longer pass.
- Report §5's red/green output for the concurrency test: **independently reproduced**, see 2.1.
- Report §4's before/after redaction output: **independently reproduced**, see 2.2.
- Report §6's four parity-spec mutations: **two of the four reproduced**, see 2.3.
- Report §7's `.env.example` dotenv claim: **reproduced** — `dotenv@16.6.1`, `parse()` on the
  committed `.env.example` yields `"86400"`, `"3600"`, `"604800"` with the inline `# 24 hours`
  comments stripped.

---

## Part 2 — the mutation experiments

Nine specs are new or changed. I mutated the source under each one that carries a security
property and watched it go red. Every mutation was reverted from a byte-identical backup and
`git status --porcelain` confirmed empty afterwards.

### 2.1 The concurrency gate — REAL, and `Promise.all` genuinely overlaps

I rewrote `consume` as read-then-write (`findUnique`, check `consumedAt` / `expiresAt` / `purpose`
in application code, then an unconditional `updateMany` on `tokenHash` alone) and ran
`pnpm vitest run --project integration apps/api/src/modules/auth/token.service.integration.spec.ts`:

```
EXIT=1
 ✓ ... (all ten sequential tests green) ...
 × two concurrent redemptions of one reset link > produces exactly one success and one refusal
   → expected [ { …(3) }, { …(3) } ] to have a length of 1 but got 2
 × two concurrent redemptions of one reset link > holds across a wider burst
   → expected [ { …(3) }, { …(3) }, { …(3) }, …(5) ] to have a length of 1 but got 8
 ✓ two concurrent redemptions of one reset link > lets two different tokens through concurrently
 Test Files  1 failed (1)
      Tests  2 failed | 11 passed (13)
```

Byte-for-byte the same failure the report records. **Proven:** the two `service.consume(...)` calls
in `Promise.all` do reach Postgres concurrently — a read-then-write implementation lets both
succeed, and a burst of eight lets all eight succeed. The test is not proving something weaker.
The negative control (two *different* tokens both succeeding) is also real and stayed green under
the mutation, so an implementation that took a global lock would not pass.

The eleven sequential tests all stayed green under the wrong implementation, which is the point.

### 2.2 The redaction change — the URL path is genuinely new coverage

I deleted the new value pattern (`redaction.ts:62`) and ran `pnpm test`:

```
EXIT=1
 × a minted secret token … > does not survive inside a verification URL under an innocent key
 × a minted secret token … > does not survive inside a reset URL in the message string itself
 × a minted secret token … > does not survive as a trailing printf interpolation argument
 × redact > applies the value-shape backstop to a token carried in a URL query parameter
 × redact > applies it to the fragment form and to a later parameter in the string
 × redactSecretsInText > redacts only the token value in a link, keeping the route readable
 Test Files  2 failed | 51 passed (53)
      Tests  6 failed | 637 passed (643)
```

The first test in `token.redaction.spec.ts` (`{ token }`, the denylisted key) **stayed green**,
exactly as the report says. So three of the four token-redaction tests prove the new pattern and
one re-proves the key path that already worked — which the spec's own docblock says outright.
**The measurement in report §4 is honest and the fix is real.**

### 2.3 The error-code parity spec (ruling 27) — real, and its reshape guard works

Two of the report's four mutations reproduced:

- Removed `` , `TOKEN_INVALID` `` from `.claude/api/errors.md:84`, ran
  `pnpm vitest run --project unit packages/contracts/src/error-codes.spec.ts`: exit 1,
  `× documents every registered code → expected [ 'TOKEN_INVALID' ] to deeply equal []`.
- Renamed `## 3. Codes` to `## 3. Error codes`: exit 1, collection error
  `Error: errors.md has no "## 3. Codes" heading.` — **this is the guard that matters.** Without
  it, a reshaped document makes `documented` become `[]` and every set comparison passes. It works.

This is the first parity spec between `ERROR_CODES` and `api/errors.md` §3, closing carry-forward
ruling 27, which has been open since Task 3.

### 2.4 The TTL-completeness spec (ruling 2's tripwire) — real

I added `MUTANT_PURPOSE` to `enum VerificationPurpose` in `schema.prisma`, let
`pnpm build:packages` regenerate the Prisma client, and ran `pnpm test`:

```
EXIT=1
 × TokenService TTLs > has a TTL for every value of the Prisma VerificationPurpose enum
 Test Files  1 failed | 52 passed (53)
      Tests  1 failed | 642 passed (643)
```

Reverted with `git checkout -- packages/db/prisma/schema.prisma` and regenerated (exit 0).

Worth recording for the ledger: **`packages/db/src/enum-parity.spec.ts` did not go red.** Adding a
*value* to an existing Prisma enum is not what ruling 13's spec catches — it catches a *new* enum.
So the only thing in the repository that now notices a new `VerificationPurpose` value is this
Task 4 spec in `apps/api`. That is a genuine strengthening, and it is worth the orchestrator
knowing it is the sole tripwire.

### 2.5 The module wiring spec — its docblock's claim is true

`auth.module.spec.ts`'s new docblock asserts *"remove `imports: [PrismaModule]` and the module
fails to compile with an unresolved dependency instead of quietly resolving to nothing"*. I removed
that line from `auth.module.ts` and ran the spec: exit 1, four of five tests red (only `registers no
controller` survived). **Claim verified**, and `overrideProvider(PRISMA)` does *not* paper over a
missing import.

---

## Part 3 — code findings

### HIGH

#### H1 — two concurrent `issue` calls leave **two simultaneously valid tokens** for the same user and purpose. §6's "invalidated by a newer token" does not hold under concurrency. **Proven.**

`apps/api/src/modules/auth/token.service.ts:177-185`.

```ts
await this.store.$transaction(async (tx) => {
  await tx.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: issuedAt },
  });
  await tx.verificationToken.create({ ... });
});
```

Under Postgres's default READ COMMITTED, transaction B's `updateMany` cannot see transaction A's
uncommitted `INSERT`, so B supersedes nothing and both rows commit unconsumed. There is no
`SELECT … FOR UPDATE` on the user, no `SERIALIZABLE` isolation, and — checked in
`packages/db/prisma/schema.prisma` — `VerificationToken` has only `@@index([userId, purpose])`, not
a partial unique index on `(userId, purpose) WHERE consumedAt IS NULL`, so the database does not
arbitrate either.

**How I proved it.** A temporary integration spec (created, run, deleted; `git status` clean) using
the same Testcontainers harness, firing 25 rounds of two parallel `issue` calls for one user and
purpose, deleting the rows between rounds and counting unconsumed rows:

```
PROBE live-token counts over 25 concurrent issue pairs = [1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]
PROBE max = 2
```

**24 of 25 rounds left two live password-reset tokens.** A separate single-round run confirmed both
were independently redeemable.

**What it contradicts.** The plan's Task 4 line item: *"Issuing a new token of a purpose invalidates
the outstanding ones for that user and purpose, in the same transaction as the insert."* The
transaction is there; the invalidation is not, under concurrency. `token.service.ts:155-156`'s own
docblock says `issue` mints *"invalidating that user's outstanding tokens of the same purpose in the
same transaction"*, stated without qualification.

**What the tests prove instead.** `token.service.integration.spec.ts:150-178` covers supersession
**sequentially only** — issue, then issue, then consume. `token.service.spec.ts:107-126` asserts
statement order and arguments against a recording double. Ruling 10 required a concurrency test and
the implementer built an excellent one *for `consume`*; nobody pointed the same weapon at `issue`.
This is the read-then-write defect shape one layer up, and it survived a task specifically
commissioned to eliminate it.

**Cost if shipped.** A user who double-submits "forgot password" (a double-clicked button, a client
retry, two tabs) receives two emails whose links both work. Each link is still single-use, still
expiring, still 256-bit. So this is not an account takeover by itself, and I am not claiming it is —
it is a stated security invariant that is not enforced, and it doubles the number of live reset
credentials in a mailbox per double-submitted request. It also propagates: Task 15 will build
invitation issuance on the same shape, and Ruling 5's decision that supersession writes `consumedAt`
means **the row cannot afterwards tell an operator that supersession failed to happen**.

I am reporting the defect, not the fix; a partial unique index, a row lock on `User`, or
`SERIALIZABLE` are the obvious candidates and each has a different migration cost.

### MEDIUM

#### M1 — four of the branch's six commits fail `pnpm check:openapi`, and the fix landed inside a `docs(ledger):` commit. **Proven.**

`apps/api/openapi.json` gained `"TOKEN_INVALID"` in commit **`1f8f700`** — the commit whose message
is `docs(ledger): Task 4 implementer report — commands, exit codes, both proofs` and whose only
other file is `report.md`. `TOKEN_INVALID` entered `packages/contracts/src/error-codes.ts` four
commits earlier, in `7658dbd`.

```
949c757 openapi_has_TOKEN_INVALID=0   (contracts: not yet added)
7658dbd openapi_has_TOKEN_INVALID=0   contracts: added   <-- red from here
1cb8f28 openapi_has_TOKEN_INVALID=0   contracts: present
7198550 openapi_has_TOKEN_INVALID=0   contracts: present
25363b4 openapi_has_TOKEN_INVALID=0   contracts: present  <-- the head the report was written at
1f8f700 openapi_has_TOKEN_INVALID=1   contracts: present
```

Proved by restoring the committed file and running the real check:

```
git checkout 25363b4 -- apps/api/openapi.json
out=$(pnpm check:openapi 2>&1); code=$?     # EXIT=1
```

**Cost if shipped.** The plan's Task Order rationale states the order exists *"so CI is green at
every commit"*. Task 3 was **rebase-merged** (progress.md pause state), so a rebase-merge of this
branch puts four commits on `main` on which `pnpm check:openapi` exits 1 — poisoning `git bisect`
and any per-commit CI. Separately, a change to the **shipped API contract** is hidden inside a
commit typed `docs(ledger)`, which is the one commit a reviewer skips.

**Citation consequence.** Report §3's "What was built" table lists `apps/api/openapi.json` as
regenerated, and §3's last line lists the five commits `949c757 … 25363b4`. The file is in none of
them. The report is not lying — it is describing a working tree that had the regenerated file
uncommitted — but a reader mapping the table onto the commit list gets a false picture, and report
§1's `check:openapi` exit 0 is true of that working tree and false of four commits in the history it
sits on. This is the *shape* of the phase's recurring defect even though no individual sentence is
false.

#### M2 — the new redaction pattern destroys whole log fields on three parameter names that are not usually credentials. **Measured; the impact is prospective.**

`packages/observability/src/redaction.ts:62`. The parameter alternation includes `code`, `key` and
`signature`. In `redact()` a match replaces the **entire** structured field, not the span
(`redaction.ts:124`).

Measured against the built package:

```
REDACTED | s3 object key url  'https://minio/evidence?key=evidence-01JABCDEF/report.pdf'  -> "[redacted]"
REDACTED | error code param   'https://app/callback?code=VALIDATION_ERROR'                -> "[redacted]"
REDACTED | signature param    'https://app/x?signature=abcdefghij'                        -> "[redacted]"
kept     | 'https://app/scans?query=findings-in-scope-2026'
kept     | 'https://s3/b/o?X-Amz-Signature=deadbeef…&X-Amz-Expires=900'
```

`?key=` is the shape an object-storage URL takes, and this product's whole evidence subsystem is
built on object keys (`architecture/database.md:147` `storageKey`; `security/tenant-isolation.md:159`
*"Keys prefixed `org/{organizationId}/`"*). `?code=` collides with this repository's own
SCREAMING_SNAKE error codes, every one of which clears the 8-character floor.

**What the new spec proves and what it does not.** `redaction.spec.ts`'s false-positive control
tests `?status=RUNNING&limit=50`, `?code=US` (under the floor) and `?tokenize=…`. It does **not**
test `key=`, `code=` or `signature=` with a realistic ≥8-character non-credential value — the three
names most likely to collide, and the three the implementer added. So the false-positive guard is
weaker than it looks: it proves the floor and the prefix-boundary, not the name list.

**Cost if shipped.** `grep -rn "?key=" apps packages` finds nothing today, so **this is prospective,
not present** — I want to be explicit about that. The cost lands in Phase 5 when evidence
presign/download logging arrives: an operator tracing a failed download sees `"url": "[redacted]"`
and has lost the route, which is precisely the loss `redactSecretsInText`'s docblock argues against.

#### M3 — `@sentinel/db/testing` is a new, unfenced export that hands application code an owner DSN, a Docker dependency, and a devDependency. **Proven.**

`packages/db/package.json:17-20` adds `"./testing"`. `eslint.config.js:63-91` fences
`@sentinel/db/unscoped` and `**/generated/client` by `no-restricted-imports`; `./testing` is on
neither list.

I wrote a probe at `apps/api/src/modules/auth/__probe-testing-import.ts` (non-spec, therefore not
covered by the `**/*.spec.ts` exemption at `eslint.config.js:189-207`):

```ts
import { startPostgresHarness } from '@sentinel/db/testing';
export const probe = startPostgresHarness;
```

```
ESLINT EXIT=0
TSC    EXIT=0
```

Deleted; tree clean.

Three consequences, in descending seriousness:

1. `startPostgresHarness()` returns `ownerUrl` — the **schema-owner** connection string
   (`postgres-harness.ts:10-11`, *"Owner connection — schema owner, used by migrations"*), which is
   not subject to RLS. `@sentinel/db/unscoped` is fenced for exactly this reason; this route to the
   same capability is not.
2. `@testcontainers/postgresql` is a **devDependency** of `@sentinel/db` (`package.json:38-44`). An
   application import resolves in development and CI and fails at runtime on a `--prod` install.
3. `postgres-harness.ts:40` runs `execSync('pnpm exec prisma migrate deploy')` and starts a Docker
   container. Neither belongs on any code path an application module can reach.

**What the report got right:** its verification that `apps/api` needs no new dependency is sound —
`packages/db/dist/testing/postgres-harness.d.ts` matches zero of
`testcontainers|Testcontainers|StartedPostgreSqlContainer` (`grep -c` = 0, exit 1) and
`grep -c testcontainers apps/api/package.json` = 0 (exit 1). I re-ran both. The gap is not the
dependency; it is the missing lint fence.

**Cost if shipped.** Low probability, high blast radius: one careless import gives a request-path
module a non-RLS connection with no lint error, in a codebase whose §2 security rule is that every
tenant-owned query is scoped. `coding-standards.md` §6's claim that lint enforces "no import of the
unscoped Prisma client" acquires a second exception — and the Task 14 review comment quoted at
`eslint.config.js:71-83` records that exactly this kind of unfenced sibling path has slipped through
before.

### LOW

#### L1 — `signature` and `key` are in the pattern's name list, but the anchoring means AWS-style presigned URLs are not covered. **Measured.**

The lookbehind requires `[?&#]` **immediately** before the parameter name, so `&X-Amz-Signature=…`
does not match (the preceding character is `-`). Measured above: `kept`. A presigned evidence URL is
a bearer credential for five minutes (`architecture/storage.md:40-41`,
`security/file-security.md:36`), and a reader of `redaction.ts:58-61` — *"The parameter names are
the ones this product's credentials actually travel under"* — would reasonably infer coverage that
does not exist. Not Task 4's to build; worth recording so a later task does not assume it.

#### L2 — residual leak shapes, measured, for the record

Run against the built `@sentinel/observability`, with a real 43-character token:

| Shape | Result |
|---|---|
| `…/verify?token=<T>` | redacted (both `redact` and `redactSecretsInText`) |
| `…/verify/<T>` — token as a **path segment** | **leaks** |
| `token=<T>` with no `?`/`&`/`#` before it | leaks (comment acknowledges) |
| `…?t=<T>` — short parameter name | leaks (comment acknowledges) |
| `encodeURIComponent('…?token=<T>')` — URL nested in another URL | **leaks** |
| bare `<T>` under an innocent key | leaks (inherent — indistinguishable from an id) |

The path-segment form and the percent-encoded form are not named in `redaction.ts:56-61`'s residual
list. Task 5 owns the link format; if it ever builds a path-segment link, redaction silently stops
covering it. Worth a sentence in the Task 5 brief rather than a change here.

#### L3 — the flake is broader than report §2 says, and there is a concrete unexplored lead

Report §2 states *"Every failure is in `apps/api/src/common/guards/sliding-window.integration.spec.ts`"*.
In my six runs (4 green / 2 red), the two failures were in **two different specs**:

- run 5 — `sliding-window.integration.spec.ts` › `does not charge a refused request against the
  window` → `expected 1 to be 2`. Matches the report.
- run 6 — `rate-limit.integration.spec.ts:443` › `liveness is never rate limited > issues no Redis
  command at all while probing /health/live` → ioredis `Command queue state error. If you can
  reproduce this, please report it.` **Not mentioned anywhere in the report.**

Per the brief I did not chase this, but I found one thing cheaply that is worth handing over.
`sliding-window.integration.spec.ts:13` builds its keys as
`slidingWindowKey('login', 'perIp', randomUUID())` → `ratelimit:login:perIp:<uuid>`
(`sliding-window.ts:29`). `rate-limit.integration.spec.ts:170-192` runs a **`beforeEach`** that
`SCAN`s `ratelimit:<class>:*` and `DEL`s everything it finds, for `FIXTURE_CLASSES` which includes
`'login'` (line 165). Its comment claims *"narrowed to this suite's own classes … it protects other
suites"* — **that claim is false**: the two suites share the `ratelimit:login:*` namespace on the
shared compose Redis, and a deletion there produces exactly the observed symptoms (an entry or the
whole key vanishing: `expected 1 to be 2`, `expected +0 to be 2`).

**I have not proved the two files can overlap in time** — `vitest.workspace.ts` sets
`fileParallelism: false` on the `integration` project and `pnpm test:integration` is a single vitest
process, which should serialise them. Either that setting is not being honoured for a workspace
project, or the mechanism is something else. **Suspected, not proved**, and I am labelling it as
such. It is a cheaper next step than another eight runs.

#### L4 — `consume` performs no user-status check, and nothing behind it will

`token.service.ts:225-240` returns `{ userId }` for any live row. `User.status` exists
(`UserStatus @default(ACTIVE)`, with `LOCKED`; see the schema's own comment warning against
conflating it with a brute-force lock), and `VerificationToken`'s FK is `onDelete: Cascade`, so a
*deleted* user's tokens disappear but a **locked or suspended** user's tokens still redeem.

Correct as designed — this is the endpoint's job — but carry-forward ruling 9 already records that
`VerificationToken` has no RLS behind it, so nothing in the database will catch it either. **Tasks 8,
10 and 15 must re-resolve and check `User.status` after `consume` returns.** Worth adding to their
briefs beside the audit-event carry-forward the implementer already flagged.

#### L5 — `SECRET_TOKEN_TTL_SECONDS` in `auth.tokens.ts` is defensible but re-introduces the exact confusion the brief was guarding

Report §9.6 raises this itself. My judgement: **the implementer is right on the merits.** The brief
said not to add *secret-token constants* to the DI-token file; what went in is a DI key string
(`'SENTINEL_SECRET_TOKEN_TTL_SECONDS'`), which is the only kind of thing that file holds, and the
new docblock at `auth.tokens.ts:7-13` states the two senses of "token" explicitly. The residual cost
is that the constant now carries the `SECRET_TOKEN_` prefix the brief chose to *mean* "credential",
in the one file that means "DI key" — so the prefix no longer disambiguates on its own. Cosmetic;
the docblock carries the weight. No change needed unless the orchestrator reads the ruling strictly.

---

## Part 4 — the two reported deviations, judged

### (a) Not editing `.claude/operations/monitoring.md` §2 — **the implementer is right.**

Ruling 9 said to *"update the key list quoted in `.claude/operations/monitoring.md` §2"*. That
instruction was conditional on the fix touching the key list. It did not: `SECRET_KEY_FRAGMENTS`
(`redaction.ts:10-24`) is byte-identical to `main`, and the change is one entry in
`SECRET_VALUE_PATTERNS`. I checked §2 line by line — it names the key fragments and then says *"plus
value-shape heuristics as a backstop"* without enumerating them, so **no sentence in §2 became
untrue**. Editing the key list would have documented a change that did not happen, which is the
Phase 1 defect class in its purest form. The implementer reported the deviation, gave the evidence,
and left the prose decision to the orchestrator. That is the protocol working.

One pre-existing imprecision worth the orchestrator's note, which I am **not** attributing to this
task: §2's *"Redaction is structural, not a regex over the final string"* has been only
approximately true since `redactSecretsInText` existed, and this change widens the regex's reach
over free text. If the orchestrator writes a sentence for §2, that is the sentence to write — not
the key list.

### (b) The `userId` lookup after the winning update rather than before it — **the implementer is right.**

Ruling 3 *permitted* a `findUnique` before the update as a hint and explicitly said it must never be
the gate. Placing it after the winning update makes that structurally impossible rather than
merely disciplined, which is strictly stronger than the ruling asked for.

I checked the correctness argument rather than accepting it. `tokenHash` is `@unique`
(`schema.prisma`), the row was just written by this request's own `UPDATE`, and the read is not in a
transaction — so the only way `findUnique` returns `null` is a concurrent delete (a `User` cascade),
and `token.service.ts:237` returns `null`, i.e. fails closed. The `purpose` returned to the caller
comes from the *input*, not the row, which is sound because `purpose` is in the `UPDATE`'s
predicate. `token.service.spec.ts:231-241` pins the fail-closed branch, and `:217-229` pins that a
refusal issues **one** statement and never consults the row — which is what makes the read
provably not the gate. No defect.

One nit, not a finding: the port type at `token.service.ts:67` declares `findUnique` as returning
`{ userId: string } | null`, while real Prisma returns the whole row including `tokenHash`.
Structural typing makes this safe and nothing downstream sees the extra fields, but the narrow port
understates what crosses the boundary.

---

## Part 5 — ruling compliance

| Requirement | Result | Evidence |
|---|---|---|
| No new Prisma enum value | **met** | `git diff main...1f8f700 -- packages/db/prisma/` empty |
| No migration | **met** | same |
| `check:registry` still 14 models | **met** | exit 0, `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `check:openapi` still 4 routes | **met at HEAD**, violated at four commits | `{"routes":4}`; see M1 |
| TTLs inside `apiEnvObject` before `.superRefine` (ruling 30) | **met** | `env.ts:92,93,99` inside `18-100`; `.superRefine` at `123` |
| `TOKEN_INVALID` in both lists (ruling 27) | **met**, plus the parity spec ruling 27 asked for | `error-codes.ts:39`, `errors.md:84`, and §2.3's mutations |
| Raw token returned once, never stored, never logged, never audited | **met** | `token.service.ts:187` is the only return of `minted.token`; `grep` for `logger.`/`console.`/`AuditEvent` in the three new source files finds comment text only; §2.2's mutation proves the log path |
| `TokenService` never persists a raw token | **met** | `consume` hashes at `:227` before any store call; `token.service.spec.ts:211-215` asserts `'a-raw-token'` appears in no recorded call |
| Concurrency test is the deliverable, in `apps/api`, on Testcontainers | **met and proven** | §2.1 |
| No ADR written or edited | **met** | no file under `.claude/decisions/` in the diff |
| `roadmap.md` untouched | **met** | not in the diff |
| Only authorised `.claude/` edits | **met** | `.claude/api/errors.md` is the only `.claude/` file changed |

---

## Summary

**One High, three Medium, five Low.** The citation pass found **no false sentence about a document**
— second task running — and every number in report §1 reproduced exactly. The concurrency
deliverable is genuine: I reproduced the red output independently and confirmed `Promise.all` really
does overlap two redemptions against Postgres. The redaction fix, the ruling 27 parity spec, the
ruling 2 tripwire and the module-wiring spec were all proven to fail under a real violation.

The High finding is that the same concurrency defect the task was commissioned to eliminate is
present in the other half of the service. `consume` is atomic; `issue` is not, and 24 of 25
concurrent issue-pairs left two live tokens where §6 and the plan both say there must be one. The
concurrency weapon was pointed at exactly one of the two write paths.

Nothing was fixed. `git status --porcelain` is clean apart from this file.
