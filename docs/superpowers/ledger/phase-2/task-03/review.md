# Phase 2 · Task 3 — adversarial review

> **A dated record of what was checked and observed. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Reviewer: fresh subagent, no stake in the code. Branch `feat/phase-2-task-03`
at `5701461`, working tree clean at the start and at the end of this review. Machine: Windows 11
x64, `node --version` → `v26.7.0`, `pnpm --version` → `11.5.0`, 12 logical CPUs.

**Verdict: no High findings. Three Medium, eight Low.** The two specs that *are* the security
deliverable both go genuinely red under real violations — I broke each of them on purpose and
watched them fail. Every command in the implementer's report reproduces at the number it claims,
and the HIBP quotation the report leans on is verbatim correct. The Mediums are all
"a true thing is not pinned, or a sentence about it is wrong", not "the code is wrong".

---

## 1. Citation pass — before any code was read

Every factual claim in `report.md` and in every code comment the implementer wrote was checked
against the repository first. This is the pass that has caught the worst findings in Phase 1 and
Task 2. **This time it caught three Lows and no High.**

### 1.1 Verified true

| Claim | How checked | Result |
| --- | --- | --- |
| HIBP: `Add-Padding` "Pads out responses to ensure all results contain a random number of records between 800 and 1,000." | `WebFetch https://haveibeenpwned.com/API/v3` | **Verbatim match** |
| HIBP: "Padded entries always have a password count of 0 and can be discarded once received." | same fetch | **Verbatim match** |
| `app.module.ts:37` registers `AuthModule` | `sed -n '30,45p'` | true |
| `apps/api/package.json:19` is `"@node-rs/argon2": "^2.1.0"` | `sed -n '15,25p'` | true; every sibling dependency also uses `^` |
| `packages/contracts/src/error-codes.ts:29` is `PASSWORD_BREACHED` in the Validation group | read | true |
| `.claude/api/errors.md:76` carries `PASSWORD_BREACHED` on the Validation line | read + `git diff` | true, and it is the only `.claude/` edit in the implementer's three commits (`.claude/decisions/README.md` moved in `17d6595`, the orchestrator's) |
| `packages/config/src/env.ts:42-70`, `booleanFromString` at `:68`, `.env.example:51-66` | read | true, all six names and all six defaults exactly as Ruling 2 fixed them |
| `password.service.ts:144` / `:116` / `:119`; `breach-check.service.ts:30` / `:36` / `:76` / `:152` / `:195`; `auth.module.ts:49`; `breach-check.service.spec.ts:82` / `:123` / `:155` / `:223`; `password.service.spec.ts:18` / `:42` / `:65` / `:75`; `auth.module.spec.ts:51`; `password.timing.spec.ts:18` / `:21` / `:45` / `:48` / `:103` | opened each | all true |
| `.claude/api/authentication.md:9`, `.claude/security/overview.md:72`, `.claude/security/authentication.md:3`, `.claude/architecture/backend.md:30`, `.claude/development/setup.md:132` — the five sentences §4 reports as made false or checked | opened each | all five say what the report says they say. §4 is accurate, including the distinction it draws between the three falsehoods and the one "weaker" item |
| Lockfile gained the umbrella plus 13 platform artefacts at lines 1035–1117, including `linux-x64-gnu` and `linux-x64-musl` | `grep -n "node-rs" pnpm-lock.yaml` | true, exactly 13 platform packages, umbrella at 1117 |
| No `minimumReleaseAgeExclude`; `pnpm-workspace.yaml` unchanged | `git diff --stat main..HEAD -- pnpm-workspace.yaml` → 0 lines | true |
| `env.spec.ts` asserts the defaults, the coercions, **seven** rejection cases, and that no `PASSWORD_*` key reached `webEnvSchema` or `sharedEnvSchema` | `git diff` of that file | true, seven `it.each` rows |
| "no maximum below 128" does not appear in anything the implementer wrote | `grep -rn "no maximum below"` | true — it appears only in the ADR (quoting it to forbid it), the briefs, `roadmap.md` and Task 2's ledger. **Ruling 11 was respected.** |
| "the only `fetch` in the module is `fetchRangeTransport`… no spec touches the network" | `grep -rn "fetch(" apps/api/src --include=*.spec.ts` → no hits | true |
| No `any`, no `console` in the ten new files | `grep -rn "\bany\b\|console\."` — only prose hits in comments | true |
| `@node-rs/argon2` declares `export declare const enum Algorithm { … Argon2id = 2 }`, and `tsconfig.base.json:21` sets `"isolatedModules": true` | read `node_modules/.pnpm/@node-rs+argon2@2.1.0/…/index.d.ts` and the tsconfig | **true — the justification for the literal `2` is correct, not a rationalisation** |
| `git diff --stat main..HEAD -- apps/web` is empty, so `pnpm test:e2e` is genuinely unreachable | ran it | true; agreeing to skip e2e is right, and the report did state the row rather than omit it |
| `apps/api/src/modules/auth/*.ts` is 1130 lines | `wc -l` | true |

### 1.2 Exit criteria, re-run by me

Each captured as `out=$(pnpm <cmd> 2>&1); code=$?`.

| Command | My exit | My output line | Report's claim | Match |
| --- | --- | --- | --- | --- |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | same | yes |
| `pnpm lint` | 0 | `Tasks: 14 successful, 14 total` | same | yes |
| `pnpm typecheck` | 0 | `Tasks: 14 successful, 14 total` | same | yes |
| `pnpm test` | 0 | `Test Files 48 passed (48)` / `Tests 589 passed (589)` | same | yes |
| `pnpm check:specs` | 0 | `59 spec files, each claimed by exactly one of: unit, integration, ui` | same | yes |
| `pnpm check:openapi` | 0 | `"routes":4` / `byte-identical` | same | **yes — still 4 routes** |
| `pnpm check:registry` | 0 | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` | same | yes |
| `pnpm build` | 0 | `Tasks: 8 successful, 8 total` | same | yes |
| `pnpm test:integration` | 0 | `Test Files 11 passed (11)` / `Tests 148 passed (148)` | same | yes |
| `docker compose ps` | 0 | mailpit / minio / postgres / redis all `(healthy)` | same | yes |
| `pnpm test` (second, after all mutations reverted) | 0 | `48 passed` / `589 passed` | — | tree restored clean |

Not a single number in report §1 is wrong. The report is unusually honest about method
(`$?` outside a pipe, deltas against a re-verified baseline).

### 1.3 Historical claims I could not verify

Report §1.2's red-then-green table describes runs that happened before the commits exist. I can
reproduce the *mechanism* (see §3) but not the historical runs. `password.service.spec.ts` today
has 20 tests, not the "2 tests" of the first green run — consistent with the file having grown
after the first rehash pair, not evidence against it. **Stated as unverifiable rather than
assumed either way.**

---

## 2. Findings

Findings are labelled **[measured]** when I proved them by running something, and **[argument]**
when they are reasoning about consequences.

### F1 — Medium **[measured]** · two of `needsRehash`'s three axes are unpinned, and the test that claims otherwise does not

`apps/api/src/modules/auth/password.service.ts:167-171` (the comparison), pinned — supposedly —
by `apps/api/src/modules/auth/password.service.spec.ts:55-63`.

That `it.each` is titled **`flags %s independently of the other two axes`**. It is not
independent for two of the three cases. Both `['a lower memory cost', {4096, 2, 1}]` and
`['a lower time cost', {8192, 1, 1}]` are compared against a raised service of `{8192, 2, 2}` —
so each differs from current configuration on the named axis **and on parallelism**. Either case
passes on the parallelism clause alone.

**How I proved it.** Three mutations, each reverted with `git checkout`:

| Mutation | Command | Result |
| --- | --- | --- |
| delete `stored.memoryCostKib < this.parameters.memoryCostKib \|\|` | `pnpm vitest run --project unit apps/api/src/modules/auth/password.service.spec.ts` | **EXIT=0, `20 passed`** |
| same, whole unit project | `pnpm vitest run --project unit` | **EXIT=0, `45 passed (45)` / `575 passed (575)`** |
| delete `stored.timeCost < this.parameters.timeCost \|\|` | file spec | **EXIT=0, `20 passed`** |
| replace `stored.parallelism < this.parameters.parallelism` with `false` | file spec | EXIT=1, `1 failed \| 19 passed` |

So `needsRehash` can silently stop detecting a raised **memory cost** — the parameter an operator
is most likely to raise, and the one `.env.example:56` puts first — and the entire unit suite
stays green. ADR-0014 says `needsRehash` "is what makes raising the parameters a real operation
rather than an aspiration". Two thirds of that mechanism currently has no test standing behind it,
under a test whose name asserts that it does.

**What should change.** Give each `it.each` row a raised service that differs from the stored
configuration on exactly the named axis — e.g. stored `{4096,2,1}` against raised `{8192,2,1}`,
stored `{8192,1,1}` against raised `{8192,2,1}`, stored `{8192,2,1}` against raised `{8192,2,2}`.
Three one-line changes. If the title stays as it is, it must become true.

### F2 — Medium **[measured]** · the log-safety assertion covers one of the four fail-open paths

`apps/api/src/modules/auth/breach-check.service.spec.ts:223-243` is the spec that enforces
Ruling 7 and critical security rule 6. It exercises **only** the `transport-error` path
(`harness(() => Promise.reject(new Error('ECONNREFUSED')))`). The other three fail-open calls —
`unexpected-status` (`breach-check.service.ts:161`), `unparseable-body` (`:167`) and `timeout`
(`:174`) — have their `reason` tag asserted and nothing else. Nothing asserts their log line is
free of the prefix.

**How I proved it.** Added `prefix: digest.slice(0, 5)` to the `unexpected-status` `failOpen`
call — a direct violation of Ruling 7 and of critical rule 6 — and ran
`pnpm vitest run --project unit apps/api/src/modules/auth/breach-check.service.spec.ts`:
**EXIT=0, `15 passed`.** The same leak on the `transport-error` path is caught immediately
(EXIT=1, `expected '[{"level":"warn",…' not to contain 'ABF7A'`), which confirms the assertion
itself works — it is just aimed at one branch out of four.

The `unexpected-status` branch is also the one most likely to fire in production (a 429 or a 503
from HIBP), and it is the only `failOpen` call that already passes an `extra` object, so it is the
easiest place for a future "let me add a bit of context" edit to land.

**What should change.** Hoist the four prefix/digest/suffix/password absence assertions into a
helper and run it against all four fail-open outcomes. The code is correct today; only the guard
against tomorrow is missing.

### F3 — Medium **[measured]** · the "~250 ms" cost that justifies reducing the timing spec's parameters is wrong by roughly two orders of magnitude on this hardware

Three code comments state 250 ms as a **cost**:

- `apps/api/src/modules/auth/password.timing.spec.ts:9-11` — "At the configured production
  starting point (m=64MiB, t=3, p=4, ~250ms per verification) the sample count below would cost
  minutes."
- `apps/api/src/modules/auth/password.service.spec.ts:8` — "the unit suite is not the place to
  spend 250ms per hash".
- `apps/api/src/modules/auth/auth.module.spec.ts:13-14` — "the production ones would cost
  ~250ms of real hashing per module build".

250 ms is a **target** in `security/authentication.md` §2 and ADR-0014, which says in as many
words that "the ~250ms target is untuned". Report §6 says "Nothing was measured about the ~250 ms
target." The comments nevertheless assert it as the observed cost.

**How I measured it.** `node -e` inside `apps/api`, against the real dependency:

```
boot hash at 64MiB/t3/p4 ms= 29.612
verify @64MiB/t3/p4 mean ms= 35.939   (n=10)
verify @16MiB/t2/p1 mean ms= 7.733    (n=10)
```

At the configured production defaults a verification costs **35.9 ms**, not ~250 ms. The timing
spec's 21 samples × 2 paths + 5 × 2 warm-ups is 52 verifications ≈ **1.9 s** at production
parameters — comfortably inside Ruling 5's 5-second budget, not "minutes". The claim is wrong by
about 100×.

Nothing needs to change in behaviour: Ruling 5 *mandated* the reduction, so the spec is compliant
either way. What is wrong is a measurement-flavoured sentence that no measurement supports, in the
comment block of the phase's most important security spec. And it has a practical consequence
worth the orchestrator's attention: **on this hardware the timing proof could run at the real
configured parameters inside budget**, which would remove the reduction argument entirely and make
the proof strictly stronger. (Whether a shared CI runner holds the same is not established by
this measurement — that is a genuinely open question, and `ubuntu-latest` is slower than 12 local
cores.)

**What should change.** Either correct the three sentences to say "the documented target is
~250 ms; measured on the development machine at 35.9 ms/verification (2026-08-25), and the
reduction is Ruling 5's requirement", or raise the timing spec to production parameters and
re-measure the budget. The orchestrator writes the replacement sentence; I am not touching it.

### F4 — Low **[measured]** · report §4 item 2's "40 tests" is 43

`report.md` §4.2: "(40 tests under `apps/api/src/modules/auth/` in `pnpm test`)". Measured from
`pnpm test`: `breach-check.service.spec.ts` 15, `auth.module.spec.ts` 4,
`password.service.spec.ts` 20, `password.timing.spec.ts` 1, `password-breached.error.spec.ts` 3 =
**43**. 40 is the count excluding `password-breached.error.spec.ts`, which is nonetheless under
that directory. Trivially fixable; recorded because the phase's rule is that a number cited is a
number checked.

### F5 — Low **[measured]** · report §3 mis-cites the line range of the doc comment it quotes

`report.md` §3 says the HIBP citation lives in "the doc comment at lines 54–65" of
`breach-check.service.ts`. The doc comment is lines **51–62**; the HIBP sentences are at
**55–61**. Off by three at both ends. Everything the report says is *in* that comment is in it.

### F6 — Low **[measured]** · "worst observed spread 4.86%" is not the worst this machine produces

`report.md` §2 and `password.timing.spec.ts:26-30` record five runs with the worst relative
difference at 0.0486, and describe 0.25 as "roughly five times that".

I re-ran the same procedure — `sed`-forced `TOLERANCE = 0.00001`, six consecutive isolated runs of
`pnpm vitest run --project unit apps/api/src/modules/auth/password.timing.spec.ts`:

| Run | existing | absent | relative | shortCircuit |
| --- | --- | --- | --- | --- |
| 1 | 8.043 ms | 8.259 ms | 0.0269 | 0.005 ms |
| 2 | 8.029 ms | 8.245 ms | 0.0269 | 0.004 ms |
| 3 | 7.829 ms | 8.406 ms | **0.0737** | 0.004 ms |
| 4 | 8.216 ms | 8.130 ms | 0.0106 | 0.004 ms |
| 5 | 7.566 ms | 7.972 ms | 0.0536 | 0.004 ms |
| 6 | 7.886 ms | 7.822 ms | 0.0081 | 0.007 ms |

The medians and the short-circuit baseline reproduce the report's numbers closely, so the
measurement method is sound and the report is honest about what it saw. But the worst spread over
eleven total runs is **7.37%**, so the real headroom at 0.25 is about **3.4×**, not 5×. Still
ample. Recorded so nobody later tightens the tolerance on the strength of "worst is 4.86%".

Timing-spec budget re-verified: three isolated runs at the shipped tolerance gave `Duration
871ms / 931ms / 922ms`, EXIT=0 each — inside Ruling 5's 5 s. In the full suite I saw `1159ms`
against the report's `675ms`; both are fine, the difference is load.

### F7 — Low **[measured]** · the negative control bounds the tolerance far more loosely than its comment claims

`password.timing.spec.ts:38-40`: "The negative control at the end of the test measures exactly
that and asserts it lands *outside* 0.25, **so the number below cannot quietly become one that
discriminates nothing**."

The control asserts `relativeDifference(existingMedian, shortCircuitMedian) > TOLERANCE`, and that
ratio is ≈ existing/shortCircuit ≈ **1500–4000**. So it only forbids a tolerance above that.

**How I proved it.** `TOLERANCE = 200`, implementation untouched:
`pnpm vitest run --project unit apps/api/src/modules/auth/password.timing.spec.ts` → **EXIT=0,
`1 passed`.** A tolerance of 200 permits a 200× timing difference between the two paths and the
file stays green.

In fairness the design is better than that makes it sound, and I checked: with `TOLERANCE = 200`
**and** the null branch short-circuited, the test still fails (`relative=3958.5000: expected
3958.500000000001 to be less than 200`), because the regression's own signal and the control's
bound are the same quantity. What a widened tolerance *would* hide is a **partial** degradation —
and that is not hypothetical, see F8's mutation, which measures at `relative=23.7` and would sail
through at 200.

**What should change.** Nothing in the code. The sentence overstates what the control does; if it
is worth strengthening, assert `TOLERANCE` itself against a literal bound, or assert the absent
median in absolute milliseconds against the existing one.

### F8 — Low **[argument, with measurement]** · timing equality holds against the dummy, not against legacy hashes

`password.service.ts:116-120, 144-153`. The dummy is built from live configuration, which is
exactly Ruling 4 and is correct. But once an operator raises the parameters, **stored** hashes are
weaker than the dummy until each owner next logs in, so:

- absent account → verify against dummy at *current* parameters
- existing account with a pre-raise hash → verify at *old*, cheaper parameters

Measured difference between the shipped default and the timing spec's reduced set: **35.9 ms vs
7.7 ms — 4.6×**, trivially observable across a network. That is a user-enumeration oracle in the
opposite direction from the one the spec proves, and it opens precisely when ADR-0014's rehash
mechanism is used.

It cannot occur today: there are no accounts, no login path, and no parameter raise has happened.
`security/authentication.md` §2 asks for "login timing equalised whether or not the account
exists"; what ships equalises against current parameters only. This is inherent to the design the
ruling mandated and I am not calling it a defect in the implementation — but nothing in the
repository records it, and **Task 9 is where it becomes real**. It belongs in Task 9's brief.

### F9 — Low **[measured]** · Argon2's `m ≥ 8p` constraint is not validated where the other config is

`packages/config/src/env.ts:59-61` validates `PASSWORD_ARGON2_MEMORY_KIB` (`min(8)`) and
`PASSWORD_ARGON2_PARALLELISM` (`min(1).max(255)`) independently. Argon2 additionally requires
memory ≥ 8 × parallelism.

**How I proved it.** `hashSync('x', {memoryCost: 8, timeCost: 1, parallelism: 4, algorithm: 2})`
→ throws `Memory cost is too small`. `{memoryCost: 8, …, parallelism: 1}` → fine.

So `PASSWORD_ARGON2_MEMORY_KIB=8 PASSWORD_ARGON2_PARALLELISM=4` passes Zod and then throws inside
`PasswordService`'s constructor at Nest boot, from a native module, with a message that names
neither variable. `development/setup.md:136` promises that a malformed variable "crashes at boot"
— it does, but the config layer whose job this is hands it off to napi and loses the variable
name. A `.superRefine` on `apiEnvSchema` naming both variables is a few lines. Low, because it
fails fast and loudly rather than quietly.

### F10 — Low **[argument]** · a corrupted stored credential produces no signal at all

`password.service.ts:181-187`. `runVerification` swallows every argon2 error and returns `false`.
The comment's reasoning is right — the thrown text derives from the stored hash and must not be
logged (critical rule 6). But the consequence is that a credential the database has corrupted is
indistinguishable from a wrong password *forever*, with no log line, no counter, and no alert.
Logging that a stored credential failed to parse — no hash, no password, no user-supplied value —
is safe and is the only way anyone would ever find out. Owed work for Task 9, where the caller
has a user id to attach.

### F11 — Low **[argument]** · `fetchRangeTransport` follows redirects to anywhere

`breach-check.service.ts:36-39` calls `fetch` with the default `redirect: 'follow'`. Nothing more
than the 5-character prefix can leak — the redirect target is chosen by the server and the URL is
rebuilt — so the ADR-0015 privacy claim is intact. But a redirect can send the request to an
arbitrary host, including loopback, link-local and metadata ranges, and no SSRF guard exists yet.
Critical security rule 9 is written about *scanner* traffic, so this is outside its letter; the
range URL is operator configuration rather than user input, which is why this is Low and not
higher. `redirect: 'error'` costs one property and forecloses it.

---

## 3. The two security claims: what I mutated, and what happened

The brief's instruction was not to read these tests and agree with them. Every mutation below was
applied to the implementation, run, and reverted with `git checkout`; `git status --short` is
empty at the end of this review.

| # | Mutation | Spec run | Result |
| --- | --- | --- | --- |
| A | **Short-circuit the null branch** — delete `await this.runVerification(this.dummyHash, password)` from `verify` | `password.timing.spec.ts` | **RED.** `existing=8.775ms absent=0.002ms shortCircuit=0.002ms relative=4874.1111: expected 4874.111111111111 to be less than 0.25` |
| B | Mutation A **plus** `TOLERANCE = 200` | same | **RED.** `relative=3958.5000: expected … to be less than 200` — the tolerance cannot be widened far enough to hide a full short-circuit without the control failing first |
| B2 | `TOLERANCE = 200` alone, implementation intact | same | GREEN — see F7 |
| H | **Bake the dummy hash at 1024/1/1 while live parameters are 16384/2/1** — Ruling 4's "timing oracle wearing a mitigation's name" | same | **RED.** `existing=9.232ms absent=0.373ms relative=23.7435: expected … to be less than 0.25` |
| C | **Send six hex characters** — `digest.slice(0, 6)` | `breach-check.service.spec.ts` | **RED**, 2 tests: `expected 'https://hibp.internal/range/ABF7AA' to be 'https://hibp.internal/range/ABF7A'` |
| C2 | **Append the full digest as a query parameter** — `/${digest.slice(0,5)}?d=${digest}` | same | **RED**, 3 tests |
| D | **Log the prefix on the `unexpected-status` path** | same | **GREEN, 15 passed** → F2 |
| D2 | **Log the prefix on the `transport-error` path** | same | **RED.** `expected '[{"level":"warn",…' not to contain 'ABF7A'` |
| I | **Remove the `timedOut \|\|` guard** from the failure classification | same | **RED.** `expected [ 'transport-error' ] to include 'timeout'` — the bug the implementer describes in §1.2 is real, the flag is load-bearing, and the fix is not cosmetic reordering |
| E/F | **Delete the memory-cost or the time-cost comparison** from `needsRehash` | `password.service.spec.ts`, then the whole `unit` project | **GREEN both times** → F1 |
| F2′ | **Neuter the parallelism comparison** | `password.service.spec.ts` | **RED**, 1 failed |
| J | **Make `needsRehash` bidirectional** (`<` → `!==`) | same | **RED**, `leaves a hash stronger than current configuration alone` — the "never downgrade a stronger hash" claim is genuinely pinned |
| G | **Add a controller to `AuthModule`** (an inline `@Controller('leak')`) | `auth.module.spec.ts` and `pnpm check:openapi` | **RED both.** Spec: 1 failed / 3 passed. `check:openapi`: EXIT=1, `"routes":5`, `The committed OpenAPI schema does not match what the contracts generate.` |

**The verdict on the two deliverable specs.** The timing spec catches a full short-circuit
(4874×), a partial short-circuit via a mis-parameterised dummy (23.7×), and survives a widened
tolerance for the regression it targets. The URL spec catches a sixth character and a query-string
smuggle. Neither is a test that agrees with itself. This is materially better than Task 2's enum
parity specs, which stayed green under a real violation — I looked for that shape here and found
it in exactly two places (F1, F2), neither of them in the two headline claims.

I also probed the fail-open paths for a hidden fail-*closed* or an unhandled rejection and found
none. `Promise.race` attaches handlers to both promises, so the aborted transport's later
rejection is handled rather than escaping; `finally { clearTimeout }` runs on every path; a
transport that throws synchronously is caught by the same `catch`; and `timeoutMs` is
`.int().min(1)` so the timer cannot be zero or negative. All four fail-open outcomes return
`false` and log exactly one `warn` line, asserted at `breach-check.service.spec.ts:178-219`.

---

## 4. The four deliberate departures — judged

**1. Registering `AuthModule` in `AppModule` (`app.module.ts:37`). Right, in scope, correctly
justified.** Ruling 1 fixed the module's shape and was silent on registration. An unregistered
provider-only module is code no check exercises — and mutation G proves the point concretely: the
`check:openapi` guard that Ruling 1 leans on (`"routes":4`) **only fires because the module is
registered**. Unregistered, a controller added here would be invisible to the check the ruling
names as its enforcement. The departure makes the ruling's own guarantee real. Its stated cost is
also real but smaller than implied: one synchronous hash at boot, measured at **29.6 ms** at the
configured defaults on this machine (see F3), on a process not yet serving requests.

**2. `PasswordBreachedError` built unprompted. Defensible; mild scope creep; keep it.** Ruling 3
required only the code in both lists, and the class is 36 lines plus one spec with no producer
until Task 8. Against that: the plan's Task 3 bullet does say a match is "refused with a clear
explanation… a 422, not a 400", the class ships no route, `check:openapi` still reports 4, and its
spec pins the three things that matter (422, the code, and that nothing hex-shaped reaches the
message or details — `password-breached.error.spec.ts:33` uses `/[0-9a-f]{5,}/i`, which would
catch a leaked prefix). Moving it to Task 8 costs more than leaving it. **My recommendation: keep,
and record it as a ruling so Task 8 does not build a second one.**

**3. `needsRehash` semantics — one-directional, and false whenever `valid` is false. Both right,
both pinned.** Mutation J proves the one-directional half is a tested property and not just a
comment. The "false when invalid" half follows from `verify`'s early return at
`password.service.ts:151` and is asserted at `password.service.spec.ts:104-111`. Rehashing a
credential you just rejected would be nonsense, and downgrading a stronger hash because an
operator lowered a number is the failure ADR-0014's mechanism exists to avoid. The plan left both
undecided; these are the decisions I would have made.

**4. The literal `2` for `ARGON2ID`. Correct, and the justification checks out.** I verified the
premise rather than taking it: `node_modules/.pnpm/@node-rs+argon2@2.1.0/…/index.d.ts:3` is
`export declare const enum Algorithm`, `Argon2id = 2` is at line 18, and `tsconfig.base.json:21`
sets `"isolatedModules": true` — under which a value import of an ambient const enum is a compile
error, because there is no runtime object. Pinning it with an assertion on the emitted
`$argon2id$` tag (`password.service.spec.ts:75-82`) rather than trusting the constant is the right
way to do this.

---

## 5. Rulings and rules I checked and found honoured

- **Ruling 1** — no controller, no route. `check:openapi` → `"routes":4`, and mutation G shows two
  independent guards catch a route being added.
- **Ruling 2** — all six variables on `apiEnvSchema` with the specified defaults, `booleanFromString`
  reused, `.env.example` updated, and `env.spec.ts` asserts no `PASSWORD_*` reached `webEnvSchema`
  or `sharedEnvSchema`.
- **Ruling 3** — `PASSWORD_BREACHED` in both lists, Validation group, 422, message names the breach
  and asks for a different password, nothing password-derived in message or details.
- **Ruling 4** — `verify(storedHash: string | null, password)`; dummy built in the constructor from
  `this.options()`, seeded from `randomBytes(32)` so no user chooses the comparison string.
  Mutation H shows a dummy at drifted parameters is caught.
- **Ruling 5** — reduced parameters, 21 samples (≥15), medians, tolerance justified in a comment,
  budget met (871–931 ms isolated). The tolerance's *number* is sound even though the spread claim
  behind it is understated (F6) and the reduction's justification is overstated (F3).
- **Ruling 6** — one injected function-type transport; exact-string URL assertion; no spec touches
  the network; `Add-Padding` sent, and the comment claiming its effect is now **verified against
  HIBP's own documentation**, verbatim, by me as well as by the implementer.
- **Ruling 7** — four reason tags, `warn` via `createLogger`, `reason` and `elapsedMs` only, no URL,
  no error object; fail-open return asserted on timeout, 500, garbage body and a throwing
  transport. The log-*safety* assertion is under-aimed (F2), but the code obeys the ruling.
- **Ruling 8** — the rehash test exists with its negative and a one-directional case. Its
  independence claim does not hold (F1).
- **Ruling 11** — `passwordSchema` untouched; the forbidden phrase appears nowhere the implementer
  wrote.
- **Rulings 14 and 16** — no endpoint, no principal parsing; nothing here engages them beyond
  adding a code that no producer yet raises.
- **Critical security rules** — 5 (nothing raw stored), 6 (nothing sensitive logged; verified by
  mutation on one path and by reading the other three), 8/2/3/10 not engaged by this task.
- **Core rules** — strict TypeScript, no `any`, no `console`, Zod at the config boundary, no
  unbounded work, no new N+1 (no database access at all in this task).

---

## 6. What I would tell the orchestrator

This is good work. The report is the most accurate one in the phase's ledger so far: I checked
roughly forty citations and found three off-by-a-little numbers and no invented quotation, no
misattributed sentence, and no claim about a document that the document does not make. The HIBP
quotation — the one the brief singled out as needing external verification — is verbatim correct,
which I confirmed by fetching `https://haveibeenpwned.com/API/v3` myself. Every exit code
reproduces.

The two security deliverables are real tests, not decorations. I tried five different ways to
violate them and they went red every time.

**Three things are worth fixing before this merges**, and none of them require touching behaviour:

1. **F1** — three one-line edits so the `needsRehash` axes are actually independent. This is the
   one finding where a real regression currently passes the whole suite.
2. **F2** — aim the log-safety assertion at all four fail-open paths, not one.
3. **F3** — correct the "~250 ms" cost sentences, or (better) re-measure and consider running the
   timing proof at production parameters, which this hardware says fits inside the budget.

**Two things belong in a later brief rather than here:** F8 (the legacy-hash timing asymmetry) in
Task 9's, and F10 (no signal on a corrupt credential) with it.

I fixed nothing and I edited no `.claude/` document or `roadmap.md`.

---

## Re-review of the fix round (2026-08-25)

> **A dated record of what was checked and observed in a second, scoped pass. Not a description
> of current state — [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only
> authority on that.**

Second reviewer, fresh, no stake in the code and none in the review above. Branch
`feat/phase-2-task-03` at `358db43`; fix round `3faac77..358db43`. Working tree clean at the
start and at the end. Machine: Windows 11 x64, `node --version` → `v26.7.0`,
`pnpm --version` → `11.5.0`, 12 logical CPUs. Docker running, all four services `(healthy)`.

**Scope: two questions only** — does each fix fix what it claims, and did any fix break or
weaken something else. The whole task was not re-reviewed.

**Verdict: the fix round is sound. All seven findings dispositioned FIX are fixed. Nothing was
broken or weakened, and no correction introduced a false claim.** Three nits and one coverage
gap are recorded below; none is a defect and none should hold the merge.

Every mutation below was applied to the working tree, run, and reverted with `git checkout`.
`git status --short` is empty at the end of this re-review.

### F1 — **fixed** [measured]

Each `it.each` row now carries its own raised service (`password.service.spec.ts`, the
`flags %s independently of the other two axes` block): stored `{4096,2,1}` vs raised
`{8192,2,1}`; stored `{8192,1,1}` vs `{8192,2,1}`; stored `{8192,2,1}` vs `{8192,2,2}`. I read
each pair — each differs from its raised service on exactly the named axis.

Mutations E and F re-applied by me, at both scopes:

| Mutation | Command | Result |
| --- | --- | --- |
| delete `stored.memoryCostKib < this.parameters.memoryCostKib \|\|` | `pnpm vitest run --project unit apps/api/src/modules/auth/password.service.spec.ts` | **EXIT=1**, `Tests 1 failed \| 19 passed (20)`, `× flags a lower memory cost independently of the other two axes`, `AssertionError: expected { valid: true, needsRehash: false } to deeply equal { valid: true, needsRehash: true }` |
| same | `pnpm vitest run --project unit` | **EXIT=1**, `Test Files 1 failed \| 44 passed (45)` |
| delete `stored.timeCost < this.parameters.timeCost \|\|` | file spec | **EXIT=1**, `Tests 1 failed \| 19 passed (20)`, `FAIL … flags a lower time cost independently of the other two axes`, same assertion |
| same | `pnpm vitest run --project unit` | **EXIT=1**, `Test Files 1 failed \| 44 passed (45)` / `Tests 1 failed \| 579 passed (580)` |

Both were GREEN at both scopes before the fix (F1 above). The implementer's table reported
`574 passed (575)` for the whole-project runs against my `579 passed (580)`; the difference is
exactly F9's five new tests, added in a later commit. Consistent, not a discrepancy.

### F2 — **fixed** [measured]

`expectFailOpenLogIsSafe(lines, reason)` is called from all four fail-open tests. I did not take
that on the call sites — I leaked the prefix at each of the three `failOpen` call sites in turn.
Command in every row:
`pnpm vitest run --project unit apps/api/src/modules/auth/breach-check.service.spec.ts`.

| Mutation | Result |
| --- | --- |
| `prefix: digest.slice(0, 5)` added to the `unexpected-status` call (`breach-check.service.ts:175`) | **EXIT=1**, `Tests 1 failed \| 14 passed (15)`, `FAIL … allows the password on a 500`, `AssertionError: expected '[{"level":"warn",…' not to contain 'ABF7A'` |
| same on the `unparseable-body` call (`:181`) | **EXIT=1**, `Tests 1 failed \| 14 passed (15)`, `FAIL … allows the password on a garbage body`, same assertion |
| same on the `catch` call, `failOpen(reason, …)` (`:188`) | **EXIT=1**, **`Tests 2 failed \| 13 passed (15)`** — `allows the password when the range API times out` **and** `allows the password when the transport throws`, same assertion on both |

Four distinct fail-open outcomes, four distinct red tests. The "three call sites, four reasons"
claim is correct and I verified it in the implementation rather than from the commit message:
`unexpected-status` at `:175`, `unparseable-body` at `:181`, and the `catch` at `:188` serving
both `timeout` and `transport-error` via the `timedOut` flag.

The new guard-on-the-guard was tested, not read. Adding a fifth tag
(`type FailureReason = 'rate-limited' | 'timeout' | …`): **EXIT=1**, `Tests 1 failed | 14 passed
(15)`, `FAIL … has no reason tag and no log call site the four tests above do not cover`.

The test the fix deleted asserted length-1, `level`, `elapsedMs` and four absences on one path.
All of it is now inside the helper, which additionally pins the `reason` tag and adds the
lower-case digest and suffix. Strictly stronger; nothing was lost.

### F3 — **fixed** [measured]

The three comments now state ~250 ms as the documented target and give a dated,
hardware-stamped measurement. Both citations checked and true:
`.claude/security/authentication.md:27` gives "~250ms (starting point: m=64MiB, t=3, p=4)" as a
tuning target, and `.claude/decisions/ADR-0014-*.md:108` reads "**The ~250ms target is
untuned.**" No comment now asserts 250 ms as a cost. Ruling 23 is honoured.

Re-measured independently — `node -e` inside `apps/api` against `@node-rs/argon2@2.1.0`:

```
hashSync @64MiB/t3/p4 ms= 27.847
verify   @64MiB/t3/p4 mean ms= 35.165   (n=10)
verify   @16MiB/t2/p1 mean ms=  8.757   (n=10)
```

against the comments' 37.4 / 36.0 / 9.2. The two verification figures — the ones the "~1.9 s for
52 verifications, not minutes" conclusion actually rests on — reproduce within 3%. And
`pnpm vitest run --project unit apps/api/src/modules/auth/password.service.spec.ts` three times
gave `tests 154ms / 161ms / 164ms` against the comment's 146 ms.

**Nit, recorded not charged.** The 37.4 ms single `hashSync` is above the range I see: five
fresh processes each performing one cold `hashSync` at the configured defaults gave 27.425,
28.865, 34.321, 31.191, 27.613 ms. It is a one-sample measurement of a noisy quantity, it is
labelled with its date and hardware exactly as Ruling 23 requires, and no conclusion depends on
it. Not a false claim.

The parameter reduction stands per Ruling 22; I did not re-argue it.

### F6 — **fixed**, with an observation the orchestrator should see [measured]

The `TOLERANCE` comment now carries eleven runs. I checked the transcription against both
sources: the implementer's five (0.0122, 0.0263, 0.0252, 0.0486, 0.0308) match report §2, and
the six attributed to review `3c5d694` (0.0269, 0.0269, 0.0737, 0.0106, 0.0536, 0.0081) match
F6's table above, digit for digit. Worst is 0.0737; 0.25 / 0.0737 = 3.39, so "~3.4×" is correct
arithmetic. "Medians ranged 7.4–10.1 ms" still holds over the combined sample. `TOLERANCE` is
still `0.25`, `SAMPLES` still 21, `REDUCED` still `{16_384, 2, 1}`, `WARMUP` still 5.

**But I ran the same procedure six more times** — `TOLERANCE` forced to `0.00001`, six isolated
runs of `pnpm vitest run --project unit apps/api/src/modules/auth/password.timing.spec.ts`:

| Run | existing | absent | relative | shortCircuit |
| --- | --- | --- | --- | --- |
| 1 | 8.328 ms | 8.618 ms | 0.0349 | 0.004 ms |
| 2 | 8.579 ms | 9.174 ms | 0.0693 | 0.006 ms |
| 3 | 9.675 ms | 8.972 ms | **0.0784** | 0.008 ms |
| 4 | 8.097 ms | 8.310 ms | 0.0263 | 0.004 ms |
| 5 | 8.320 ms | 8.520 ms | 0.0240 | 0.004 ms |
| 6 | 8.406 ms | 7.903 ms | 0.0637 | 0.004 ms |

**0.0784 is worse than the 0.0737 the corrected comment names as the worst.** The sentence is
not false — it is correctly scoped to "over all eleven" and is a dated observation. What is now
optimistic is the figure derived from it: over seventeen runs the headroom at 0.25 is **~3.19×**,
not 3.4×.

The right reading is not that the comment is wrong twice. It is that **the worst-case spread of
this measurement is not converging** — each batch has produced a new maximum (4.86% → 7.37% →
7.84%). That supports the conclusion the comment already draws (do not tighten the tolerance)
and argues against ever quoting a headroom multiple as if it were a property of the tolerance.
My suggestion, for the orchestrator not for me: keep 0.25, and consider replacing "~3.4×" with
the observation that repeated sampling keeps finding a new worst. **I fixed nothing.**

### F7 — **fixed** [measured]

The control's comment now states what it bounds and what it does not. I verified both of its
load-bearing claims rather than reading them. Command in both rows:
`pnpm vitest run --project unit apps/api/src/modules/auth/password.timing.spec.ts`.

| Claim in the comment | Mutation | Result |
| --- | --- | --- |
| `TOLERANCE = 200` with the implementation intact stays green | `TOLERANCE = 200` only | **EXIT=0, `Tests 1 passed (1)`** |
| `TOLERANCE = 200` plus a short-circuited null branch still fails | also replaced `await this.runVerification(this.dummyHash, password)` in `verify` with a comment | **EXIT=1**, `relative=4514.1364: expected 4514.136363636363 to be less than 200` |

Both true. The reviewer's figure for the second was 3958.5; mine is 4514.1 — same phenomenon,
run-to-run variation, and the comment says "at relative=3958.5" attributed to that run, which is
how it should be written.

**Two nits.** The gap the comment calls "~1500-4000×" measured 1209–2101 across my six
forced-tolerance runs, so the lower end of that range is optimistic. And the `TOLERANCE`
comment's "a relative difference in the thousands, three orders of magnitude outside this
tolerance" understates it — 2000 against 0.25 is a factor of 8000, nearly four orders; the
sentence it replaced said four. Both nits err toward *understating* the test's strength, so
neither can mislead anyone into trusting it more than it deserves. Recorded, not charged.

### F9 — **fixed** [measured]. This was the highest-risk fix and it holds.

**The boundary, measured at more points than claimed, in both directions.** Against
`@node-rs/argon2@2.1.0` directly, `hashSync('x', {memoryCost: m, timeCost: 1, parallelism: p,
algorithm: 2})`:

```
m=8    p=4   THROWS: Memory cost is too small     m=8    p=1   OK
m=31   p=4   THROWS: Memory cost is too small     m=32   p=4   OK
m=23   p=3   THROWS: Memory cost is too small     m=24   p=3   OK
m=15   p=2   THROWS: Memory cost is too small     m=16   p=2   OK
m=2039 p=255 THROWS: Memory cost is too small     m=2040 p=255 OK
```

Exactly 8p, including at the schema's parallelism ceiling. Then the same ten pairs through
`loadEnv(apiEnvSchema, …)` against the built package — **the schema accepts and rejects at
exactly the same ten points**, with arithmetically correct messages every time:

```
m=8    p=4   REJECTED vars=["PASSWORD_ARGON2_MEMORY_KIB","PASSWORD_ARGON2_PARALLELISM"]
             PASSWORD_ARGON2_MEMORY_KIB: must be at least 32
             PASSWORD_ARGON2_PARALLELISM: must be at most 1
m=31   p=4   REJECTED   … must be at least 32   / … must be at most 3
m=23   p=3   REJECTED   … must be at least 24   / … must be at most 2
m=15   p=2   REJECTED   … must be at least 16   / … must be at most 1
m=2039 p=255 REJECTED   … must be at least 2040 / … must be at most 254
m=8/1, m=16/2, m=24/3, m=32/4, m=2040/255   ACCEPTED
```

Defaults still load as `65536 / 3 / 4`. Both variables are named, both bounds are given, and
**each message alone is a sufficient fix** — raising memory to the stated minimum or lowering
parallelism to the stated maximum each produces a valid pair. The field rule `min(8)` guarantees
`Math.floor(m / 8) >= 1`, so the `too_big` bound can never be an unsatisfiable "at most 0".

**The `ZodEffects` hazard — carry-forward ruling 15 — verified myself across the whole repo.**
`grep -rn "apiEnvSchema"` over `.ts/.tsx/.js/.mjs/.cjs/.json/.md`, excluding `node_modules` and
the ledger, returns:

- `packages/config/src/env.spec.ts:117` — the only `.shape` reader, now `.innerType().shape`,
  with a comment naming the ruling.
- `packages/config/src/env.ts:145` (`z.infer`) and `packages/config/src/index.ts:1` (re-export).
- `apps/api/src/main.ts:15`, `apps/api/src/openapi/cli.ts:29`,
  `apps/api/src/infrastructure/config/config.module.ts:22` — all `loadEnv(apiEnvSchema)`, whose
  signature is `<TSchema extends z.ZodTypeAny>`, which a `ZodEffects` satisfies.
- `apps/api/src/modules/auth/password.service.spec.ts:19` and
  `.claude/operations/environments.md:54` — prose mentions.
- Everything else is `apps/api/dist`, `apps/web/.next` and `packages/config/dist` build output.

**Nothing calls `.extend()`, `.merge()`, `.partial()`, `.pick()` or `.omit()` on it.** I checked
`e2eEnvSchema` specifically, because a chained schema is where this would hide: it extends
`webEnvSchema`, not `apiEnvSchema`. The implementer's grep claim is accurate, and ruling 15's
hazard is real here and has been handled.

**The `too_small`/`too_big` workaround in place of a `custom` issue — judged sound.**
`load-env.ts`'s `describeIssue` deliberately renders only authored rule parameters and never
`issue.message`; its own doc comment calls that safety-by-construction rather than an audit of
Zod's error-map text, and `case 'custom'` falls through to `` `failed validation (${issue.code})` ``,
which names no rule. So the workaround is not a smuggle: on a number field `too_small` and
`too_big` render as "must be at least N" / "must be at most N", and both statements are
*literally true* of the dynamic constraint at the values in play — verified at ten points above.
The one thing lost is that neither message states the *relationship*: an operator sees two bounds
rather than "memory must be at least 8 × parallelism". `EnvValidationError.variables` names both
variables and the two lines print together, so the pair is visible and either bound is
individually actionable. I would not change it, and `load-env.ts` was correctly left untouched.

**Test count.** `pnpm vitest run --project unit packages/config/src/env.spec.ts` → `Tests 28
passed (28)`. `pnpm vitest run --project unit apps/api/src/modules/auth` → `Test Files 5 passed
(5)` / `Tests 43 passed (43)`, so C1's corrected 43 still holds and F1/F2 added no test.
`breach-check.service.spec.ts` is still 15 (F2 removed one and added one). The diff adds exactly
five rows to `env.spec.ts` (one failure case, three `it.each` boundary rows, one `m=31/p=4`
refusal), and 594 − 5 = 589 is the pre-fix baseline. **Not independently verified:** I did not
check out the pre-fix commit to count `env.spec.ts` at 23; that half of the claim rests on the
diff and on arithmetic, not on a measurement.

### F11 — **fixed** [measured], but unpinned by any test

`redirect: 'error'` is on the real fetch — `breach-check.service.ts:47-53` — and
`fetchRangeTransport` is the only `fetch` in the module (`grep -rn "fetch(" apps/api/src/modules/auth/`
→ one hit) and the only transport wired in production
(`auth.module.ts:49`, `{ provide: HIBP_RANGE_TRANSPORT, useValue: fetchRangeTransport }`). The
property is a literal written after `headers: { ...init.headers }`, and nothing in the call can
override it: `init` is read field by field and never spread into the options object. Nothing
re-enables following.

I reproduced the implementer's evidence with my own local redirect server (a `node:http` server
answering `302 Location: http://169.254.169.254/latest/meta-data/`):

```
follow -> REJECTED: TypeError / connect ENETUNREACH 169.254.169.254:80
error  -> REJECTED: TypeError / unexpected redirect
```

Identical to the commit message. `follow` genuinely reaches the point of opening a TCP connection
to the metadata address; `error` rejects before any connection.

**Gap, not a regression: no test pins this.** Deleting the `redirect: 'error'` line leaves
`pnpm vitest run --project unit apps/api/src/modules/auth/breach-check.service.spec.ts` at
**EXIT=0, `Tests 15 passed (15)`** — the exact shape F2 was about, one level down. The fix round
did not introduce it: `fetchRangeTransport` has no test coverage at all, because every spec
injects a stub, and ADR-0015 line 116 already records that "no test proves the real integration
works". Pinning it needs an integration test with a real HTTP server, out of this task's scope.
Worth a carry-forward line rather than a fix here.

### Did any fix break or weaken anything?

**No.** I looked at the four places where these fixes could have cost something.

1. **F2 replaced a test rather than adding one.** Every assertion the deleted test made — length
   1, `level`, `elapsedMs`, and the password/digest/suffix/prefix absences — is inside
   `expectFailOpenLogIsSafe`, which now runs on four paths instead of one, plus the `reason` tag
   and two lower-case absences that did not exist before. Net strictly stronger, proven by the
   four mutations above.
2. **The new guard-on-the-guard reads its own source text** via
   `readFileSync(new URL('./breach-check.service.ts', import.meta.url))`. That is unusual and
   worth naming: it couples the spec to source formatting and would break if the unit project
   ever ran against compiled output. It works today (`pnpm test`, `pnpm build` and `check:specs`
   all green), the `[^;]+` union regex tolerates a reflowed multi-line declaration, and it goes
   genuinely red on a fifth tag. Acceptable; not a defect.
3. **F9's `ZodEffects` is the change most able to break something at a distance**, and it did
   not: `pnpm typecheck` → `Tasks: 14 successful, 14 total`, `ApiEnv` is unchanged because
   `z.infer` of a `ZodEffects` is the inner output type, and the whole-repo grep above accounts
   for every reader.
4. **No `.claude/` document was made false** by any of the seven fixes, and none was edited
   (`git diff --stat 3c5d694..358db43` touches five source files, two spec-adjacent config files
   and two ledger files — no `.claude/` path). I checked the three documents the fixes touch on:
   `development/setup.md:135-138` promises the config layer names the offending variable, which
   F9 makes *more* true; `security/authentication.md:27` and ADR-0014:108 are quoted accurately
   by the corrected comments; ADR-0015 makes no claim about redirects that F11 disturbs.

One small omission worth a line: **`.env.example:51-58` documents the three Argon2 variables but
not the `m >= 8p` relationship.** The boot error names both variables and both bounds, so an
operator who trips it is not stranded — but the template is where they would look first. A
one-line comment would close it. Not a defect and not a blocker.

### Exit criteria, re-run by me at `358db43`

Each captured as `out=$(pnpm <cmd> 2>&1); code=$?` — exit code outside a pipe. Working tree
clean, every mutation reverted, before this sweep.

| Command | My exit | My output line | Fix round's claim | Match |
| --- | --- | --- | --- | --- |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | same | yes |
| `pnpm lint` | 0 | `Tasks: 14 successful, 14 total` | same | yes |
| `pnpm typecheck` | 0 | `Tasks: 14 successful, 14 total` | same | yes |
| `pnpm test` | 0 | `Test Files 48 passed (48)` / `Tests 594 passed (594)` | same | **yes — 594** |
| `pnpm check:specs` | 0 | `59 spec files, each claimed by exactly one of: unit, integration, ui` | same | yes |
| `pnpm check:openapi` | 0 | `"routes":4` / `byte-identical to what the contracts generate` | same | **yes — still 4 routes** |
| `pnpm check:registry` | 0 | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global` | same | yes |
| `pnpm build` | 0 | `Tasks: 8 successful, 8 total` | same | yes |
| `pnpm test:integration` | 0 | `Test Files 11 passed (11)` / `Tests 148 passed (148)` | same | yes |
| `docker compose ps` | 0 | mailpit / minio / postgres / redis all `(healthy)` | same | yes |

`pnpm test:e2e` not run, for the reason already accepted above: no `apps/web` path is touched by
this branch or by the fix round.

**Not verified by me, and stated as such:** the fix round's historical red/green runs (its own
mutation table) are runs that happened before these commits existed — I reproduced the mechanism
of every one of them, but not the runs; and the pre-fix `env.spec.ts` count of 23, which I
derived from the diff rather than measured.

### What I would tell the orchestrator

The fix round does what it says. Seven findings, seven fixes, and the two that mattered — F1 and
F2, the only places in this task where a real regression passed a green suite — are now caught by
mutation at every scope I tried. F9, the riskiest edit, is correct at the exact boundary the
native library enforces, and its `ZodEffects` fallout is fully accounted for.

Most notably for a branch with this history: **no correction introduced a new false claim.**
Every replacement sentence I checked against a document says what the document says, and every
replacement number reproduces under my own measurement. The one figure already overtaken (F6's
3.4×) was overtaken by new data I generated, not by an error in the sentence.

Nothing here should hold the merge. Three items for a later brief or a ruling, in order of worth:

1. **`redirect: 'error'` is unpinned** — removing it leaves the suite green. Same shape as F2.
   `fetchRangeTransport` has no coverage at all and ADR-0015 already records that.
2. **Stop quoting a headroom multiple for `TOLERANCE`.** Three sampling batches have produced
   three new maxima (4.86% → 7.37% → 7.84%). The tolerance value is right; the multiple is a
   number that keeps needing correcting.
3. **`.env.example` could name the `m >= 8p` rule** beside the three Argon2 variables.

I fixed nothing, edited no `.claude/` document, and did not touch `roadmap.md`.
