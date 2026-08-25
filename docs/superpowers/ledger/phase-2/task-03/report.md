# Phase 2 · Task 3 — implementer report

> **A dated record of what was run and observed. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Branch `feat/phase-2-task-03`, three code commits on top of `e914bf1`
(the brief) and `17d6595` (the two ADRs).

Machine: Windows 11 x64, `node --version` → `v26.7.0`, `pnpm@11.5.0`.

## 1. Commands

Each run as `out=$(pnpm <cmd> 2>&1); code=$?` — exit code captured outside a pipe.
Sweep taken 2026-08-25 at 18:01 local, working tree clean, at commit `c9d593a`.

| Command | Exit | Output line establishing it |
| --- | --- | --- |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` | 0 | `Tasks: 14 successful, 14 total` |
| `pnpm test` | 0 | `Test Files 48 passed (48)` / `Tests 589 passed (589)` |
| `pnpm check:specs` | 0 | `59 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm check:openapi` | 0 | `"routes":4` / `byte-identical to what the contracts generate` |
| `pnpm check:registry` | 0 | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` |
| `pnpm build` | 0 | `Tasks: 8 successful, 8 total` |
| `pnpm test:integration` | 0 | `Test Files 11 passed (11)` / `Tests 148 passed (148)` |
| `docker compose ps` | 0 | `mailpit / minio / postgres / redis` all `(healthy)` |

Deltas against the brief's re-verified Task 2 baseline (43 files / 536 tests unit,
11 files / 148 tests integration, 54 spec files, 4 routes):

- unit `43 → 48` files, `536 → 589` tests (+5 files, +53 tests)
- `check:specs` `54 → 59` spec files (+5)
- integration `11 files / 148 tests` unchanged — this task adds no integration spec
- `check:openapi` **4 routes, unchanged** (Ruling 1)
- `check:registry` `14 models` unchanged

`pnpm test:e2e` **was not run.** Task 3 ships no controller, no route and no page: nothing it
produces is reachable from a rendered browser page, and `git diff --stat main..HEAD` lists no
`apps/web` path. The brief's "What done looks like" does not require it.

### 1.1 Install

`pnpm --filter @sentinel/api add @node-rs/argon2@2.1.0` → exit 0. No
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, as the brief predicted. `pnpm-lock.yaml` gained the
umbrella package plus 13 platform artefacts (`grep -n "node-rs" pnpm-lock.yaml`, lines
1035–1117), including `@node-rs/argon2-linux-x64-gnu@2.1.0` and
`@node-rs/argon2-linux-x64-musl@2.1.0` — the two ADR-0014 calls out for CI and for a future
Alpine image. **No `minimumReleaseAgeExclude` entry was added**; `pnpm-workspace.yaml` is
unchanged on this branch.

The specifier was changed from the exact `2.1.0` that `pnpm add` wrote to `^2.1.0`
(`apps/api/package.json:19`) to match every other dependency in that file, then `pnpm install`
re-run → exit 0.

### 1.2 Test-first evidence (Ruling 8)

Both security claims and the rehash claim were written as specs and observed red before the
code existed.

| Spec | Red run | Green run |
| --- | --- | --- |
| `password.service.spec.ts` (rehash) | `Error: Cannot find module './password.service.js'`, EXIT=1 | 2 tests, EXIT=0 |
| `breach-check.service.spec.ts` (5-char URL) | `Failed to load url ./breach-check.service.js`, EXIT=1 | 15 tests, EXIT=0 |
| `password.timing.spec.ts` | see §2 — five runs with the tolerance forced to `0.00001`, EXIT=1 each | 1 test, EXIT=0 |

One further red was produced by the implementation rather than by a missing file, and it found
a real defect: `expected [ 'transport-error' ] to include 'timeout'`. Aborting the controller
makes the transport's own promise reject, and that rejection can settle the `Promise.race`
before the timeout's does, filing a timeout under the wrong reason. Fixed with an explicit
`timedOut` flag (`apps/api/src/modules/auth/breach-check.service.ts:127-133` and `:172-174`)
rather than by reordering, because the same ordering hazard exists for the real `fetch`
transport, whose abort rejects with `AbortError`.

## 2. The timing spec: observed spread and the tolerance

`apps/api/src/modules/auth/password.timing.spec.ts`. Reduced parameters
m=16384 KiB / t=2 / p=1 (line 18), 21 samples per path (line 21), warm-up 5 (line 48),
paths interleaved, medians compared (assertion at line 103).

**Observed, five consecutive runs with `TOLERANCE` forced to `0.00001` so every run printed:**

| Run | existing median | absent median | relative | short-circuit median |
| --- | --- | --- | --- | --- |
| 1 | 7.952 ms | 8.049 ms | 0.0122 | 0.004 ms |
| 2 | 7.638 ms | 7.442 ms | 0.0263 | 0.005 ms |
| 3 | 7.817 ms | 7.625 ms | 0.0252 | 0.004 ms |
| 4 | 7.730 ms | 7.372 ms | 0.0486 | 0.003 ms |
| 5 | 9.785 ms | 10.086 ms | 0.0308 | 0.006 ms |

Worst observed spread **4.86%**.

**Tolerance chosen: 0.25** (`password.timing.spec.ts:45`), roughly 5× the worst observed
spread. The reasoning, also written into the comment at lines 23–44: the assertion is not
trying to resolve a few percent of scheduler jitter on a shared runner, it is trying to catch
the one regression that matters — an early return on the absent-account branch. That
regression measures 0.003–0.006 ms against ~7.8 ms, a relative difference near 2000, four
orders of magnitude outside 0.25. A tighter number buys no additional detection and buys a
flaky security test.

**The tolerance is not asserted only in the passing direction.** The spec samples the
short-circuit baseline every iteration and asserts it lands _outside_ the same tolerance
(lines 109–115). Without that, the tolerance could be widened until it discriminated nothing
and the file would stay green.

**Budget.** Ruling 5's budget was 5 seconds. Three isolated runs at the chosen tolerance:
`Duration 917ms`, `958ms`, `978ms`, EXIT=0 each. Inside the full suite the file reports
`675ms`.

**Flakiness check.** `pnpm test` was run four times after the tolerance was set — EXIT=0 and
`589 passed` every time. This branch already carries one known flaky integration spec; this is
not a second one on the evidence available, and the evidence available is four full-suite runs
on one machine, not a CI history.

## 3. HIBP `Add-Padding` — confirmed

**Yes, confirmed from HIBP's own documentation**, `https://haveibeenpwned.com/API/v3`
(Pwned Passwords section), fetched 2026-08-25. Two quotes were obtained:

- `Add-Padding` "Pads out responses to ensure all results contain a random number of records
  between 800 and 1,000."
- "Padded entries always have a password count of 0 and can be discarded once received."

The header is sent (`breach-check.service.ts:152`) and pinned by a spec
(`breach-check.service.spec.ts:123`). The second quote has a consequence Ruling 6 did not name,
and it is implemented: a padded row must be discarded on its zero count, or a padded response
could report a breach for a password that never appeared in one. That filter is `count > 0` in
`matchRangeBody` (`breach-check.service.ts:76`), cited in the doc comment at lines 54–65, and
asserted by `discards a padded entry, which always carries a count of zero`
(`breach-check.service.spec.ts:155`).

## 4. Sentences in `.claude/` this change made false

Reported, not rewritten, per the brief.

1. **`.claude/api/authentication.md:9`** — "`apps/api/src/modules/` still contains only
   `health`". `apps/api/src/modules/auth/` now exists with ten files. The rest of that sentence
   is still true: no endpoint implements the §2 shapes, and `openapi.json` still publishes four
   routes (`pnpm check:openapi` → `"routes":4`).

2. **`.claude/security/overview.md:72`** — `| Password hashing (Argon2id) | Not Implemented | 2 |`.
   Hashing, verification, `needsRehash` and timing equality exist and are tested (40 tests under
   `apps/api/src/modules/auth/` in `pnpm test`). No caller uses them yet, so the honest word is
   Partially Implemented rather than Implemented.

3. **`.claude/security/authentication.md:3`** — "**Status: Designed. Not Implemented.**"
   Now false for part of §2: Argon2id with parameters stored in the hash, the breach check, and
   login timing equalisation are built. §2's "Password change and reset revoke all other
   sessions and email the user" is not, and neither is anything in §3–§6.

Weaker, reported for completeness rather than as a falsehood:

4. **`.claude/architecture/backend.md:30`** — "Each module owns `*.controller.ts`,
   `*.service.ts`, `*.repository.ts`, `dto/`, and tests." `modules/auth/` deliberately owns no
   controller (Ruling 1) and no repository. Read as a general shape it is unremarkable; read as
   a rule it now has an exception.

Checked and **not** made false: `.claude/development/setup.md:132` ("`.env.example` documents
every variable with a safe placeholder") — all six new variables were added to `.env.example`
(lines 51–66). `.claude/api/errors.md:3-8`'s banner about §7 — adding a code with no producer
does not change what that paragraph says.

## 5. What was built, against each ruling

| Ruling | Where | Note |
| --- | --- | --- |
| 1 — `modules/auth/`, module, no controller | `auth.module.ts` | Followed. Registered in `app.module.ts:37` so Nest actually resolves it instead of it being unreferenced code. `auth.module.spec.ts:51` asserts the controller metadata is empty; `check:openapi` still reports 4 routes. Nest raised no objection to a provider-only module, as the ruling predicted. |
| 2 — config on `apiEnvSchema` | `packages/config/src/env.ts:42-70` | Followed. All six names and all six defaults as specified; `booleanFromString` reused (line 68). `.env.example:51-66`. `env.spec.ts` asserts the defaults, the coercions, seven rejection cases, and that no `PASSWORD_*` key reached `webEnvSchema` or `sharedEnvSchema`. |
| 3 — `PASSWORD_BREACHED`, both lists | `packages/contracts/src/error-codes.ts:29`, `.claude/api/errors.md:76` | Followed, both lists, Validation group. Also built the 422 `DomainError` (`password-breached.error.ts`) so Tasks 8–10 have the refusal itself and not only the code; its spec asserts 422, the code, that the message names the breach and asks for a different password, and that nothing hex-shaped appears in message or details. No parity spec was built — the ruling says that is not this task. |
| 4 — nullable stored hash, dummy from live parameters | `password.service.ts:144`, `:116` and `:119` | Followed. `verify(storedHash: string \| null, password)`. The dummy is built in the constructor from `this.options()`, and its input is `randomBytes(32)` rather than a literal so no user can pick the string it compares against. |
| 5 — reduced parameters, N≥15, medians, tolerance justified | `password.timing.spec.ts` | Followed. See §2. |
| 6 — injected transport, exact-URL assertion | `breach-check.service.ts:30`, spec `:82` | Followed. One function type, `fetch`-shaped. `expect(calls[0]?.url).toBe('https://api.pwnedpasswords.com/range/ABF7A')` — exact string, not a substring. No spec touches the network; the only `fetch` in the module is `fetchRangeTransport` (`:36`), wired solely by `auth.module.ts:49`. |
| 7 — fail open, safe log | `breach-check.service.ts:195` | Followed. Four reason tags, `warn` via `createLogger`. The line carries `reason` and `elapsedMs` and nothing else; **the URL is not logged either**, because the URL ends in the prefix (`:184`). Asserted by `breach-check.service.spec.ts:223`, which checks the serialised log against the password, the digest, the suffix, and the prefix in both cases. Fail-open return value asserted on timeout, on 500, on a garbage body, and on a throwing transport. |
| 8 — rehash test first, and the negative | `password.service.spec.ts:18` | Followed; see §1.2 for the red run. The negative (`does not flag a hash made at the current parameters`) is at line 42, plus a one-directional case at line 65 asserting a _stronger_ stored hash is left alone. |

## 6. Things done differently, or not done

- **`PasswordBreachedError` was not named by any ruling.** Ruling 3 requires only the code in
  both lists. The class was added because the plan's Task 3 bullet says a matched password is
  "refused with a clear explanation… a 422, not a 400", and that is the part of the bullet
  buildable without an endpoint. It adds no route. If the orchestrator considers it Task 8's,
  it is 36 lines plus one spec file to move.
- **`AuthModule` was imported into `AppModule`.** Ruling 1 fixed the module's shape but not
  whether it is registered. Registering it means the DI graph is actually resolved at boot and
  by `check:openapi`, rather than the module being code no check exercises. Cost: one
  synchronous Argon2id hash at 64 MiB during provider construction on every boot, including
  `check:openapi` and the API integration specs. All still pass; `check:openapi` still reports
  4 routes.
- **`needsRehash` is one-directional, and is false whenever `valid` is false.** Neither is
  specified by the plan. Rationale is at `password.service.ts:36-43` and `:158-163`; both
  behaviours are pinned by specs.
- **A non-argon2id or non-v19 stored hash reports `needsRehash: true`.** `parseArgon2Phc`
  returns `null` for those (`password.service.ts:59`) and `needsRehash` treats `null` as
  needing replacement.
- **`ARGON2ID` is the numeric literal `2`, not the library's enum** (`password.service.ts:21`).
  `@node-rs/argon2` declares `Algorithm` as an ambient `const enum` and `tsconfig.base.json`
  sets `isolatedModules: true`, under which a value import of one is a compile error. The
  literal is pinned by a spec asserting the `$argon2id$` tag in the emitted PHC string
  (`password.service.spec.ts:75`), not trusted.
- **Nothing was measured about the ~250 ms target.** Every number in this task's specs is at
  reduced parameters. ADR-0014's "the ~250ms target is untuned" consequence stands untouched.
- **No ADR was written or edited. No `roadmap.md` edit.** The only `.claude/` edit is the one
  line Ruling 3 requires (`.claude/api/errors.md:76`).

## 7. Files

Added under `apps/api/src/modules/auth/` (1130 lines total): `auth.module.ts`,
`auth.module.spec.ts`, `auth.tokens.ts`, `password.service.ts`, `password.service.spec.ts`,
`password.timing.spec.ts`, `breach-check.service.ts`, `breach-check.service.spec.ts`,
`password-breached.error.ts`, `password-breached.error.spec.ts`.

Modified: `apps/api/src/app.module.ts`, `apps/api/package.json`, `apps/api/openapi.json` (one
line, the enum member), `packages/config/src/env.ts`, `packages/config/src/env.spec.ts`,
`packages/contracts/src/error-codes.ts`, `.env.example`, `.claude/api/errors.md`,
`pnpm-lock.yaml`.

Commits: `25f2292`, `95865ee`, `c9d593a`.
