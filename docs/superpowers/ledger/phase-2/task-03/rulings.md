# Phase 2 · Task 3 — rulings and dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Written by the orchestrator after the adversarial review (`3c5d694`).

Each ruling records **the cost if it is wrong**, per the phase's ledger convention. A ruling here
is not evidence that anything works.

## Disposition of the eleven review findings

Severities are the reviewer's. "Fixed" means fixed in the fix round on this branch.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | Medium | Two of `needsRehash`'s three axes unpinned, under a test titled "independently" | **Fixed**, and the fix proven by re-running the reviewer's own mutations |
| F2 | Medium | Log-safety assertion covered 1 of 4 fail-open paths | **Fixed**, mutation D re-run |
| F3 | Medium | "~250 ms" asserted as measured cost in three comments; wrong by ~100× | **Sentences fixed. The parameter reduction stands** — see Ruling 22 |
| F4 | Low | Report §4.2 says 40 tests; it is 43 | **Corrected** in an appended, dated Corrections section |
| F5 | Low | Report §3 cites lines 54–65; the comment is 51–62 | **Corrected**, same section |
| F6 | Low | "Worst spread 4.86%" is 7.37% over eleven runs | **Comment and report corrected.** Tolerance unchanged |
| F7 | Low | The negative control's comment overstates what it bounds | **Comment fixed.** Code unchanged |
| F8 | Low | Timing equality holds vs. the dummy, not vs. legacy hashes after a raise | **Not fixed — carried forward as Ruling 24.** Task 9 owns it |
| F9 | Low | Argon2's `m >= 8p` unvalidated; fails from napi at boot, naming neither variable | **Fixed** with a `.superRefine` naming both |
| F10 | Low | A corrupted stored credential produces no signal at all | **Not fixed — carried forward as Ruling 25.** Task 9 owns it |
| F11 | Low | `fetchRangeTransport` follows redirects anywhere | **Fixed** — `redirect: 'error'`, and pinned by a spec in a third round |

## The re-review, and a third round

A scoped re-review of the fix round is appended to [`review.md`](review.md) (`419b7b0`). It
re-ran every mutation itself rather than accepting the implementer's table: **all seven fixes
verified fixed, nothing broken or weakened.** F9 was the riskiest and it holds — the `m >= 8p`
boundary was measured at ten pairs in both directions against argon2 and then the same ten through
`loadEnv`, accepting and rejecting at exactly the same points.

It raised three non-blocking items, and the orchestrator took all three in a third round
(`e33fd0a`):

1. **`redirect: 'error'` was unpinned.** Deleting the property left the whole spec file green,
   because every other test injects a fake transport. Now covered by two tests against the default
   transport with `globalThis.fetch` stubbed — still no network. **Proven by mutation**: deleting
   the property gives `EXIT=1, expected undefined to be 'error'`, and the line was restored with
   `git checkout`. A security property with no failing test behind it is a line waiting to be
   deleted by someone tidying up.
2. **The tolerance comment kept quoting a headroom multiple, and each batch invalidated the last** —
   4.86% off five runs, 7.37% off eleven, 7.84% off seventeen. That is what an unbounded jitter
   distribution does. The comment now says so and tells the next reader not to derive a multiple
   from observed maxima at all. **0.25 stands on the gap argument** — a short-circuit measures three
   orders of magnitude out — **not on a margin over the worst sample.** The value did not change.
3. **`.env.example` did not name the `m >= 8p` rule** next to the two variables it binds. It does now.

The re-review also recorded two things it explicitly did **not** verify, which is the right way to
report them: the fix round's historical red/green runs (it reproduced the mechanism, not the runs),
and the pre-fix `env.spec.ts` count of 23 (derived from the diff, not measured).

**No High findings, and the citation pass found no invented quotation or misattributed sentence.**
That is worth recording plainly, because it is the first task in this branch's history where it is
true: Phase 1 produced twelve such instances and Task 2's two worst findings were both prose. The
three Lows the citation pass did find (F4, F5, F6) are all arithmetic or line numbers in the
implementer's own report, not claims about documents that do not say what they are said to say.

**The two headline security specs were attacked, not read.** The reviewer applied eleven mutations
to the implementation and both specs went red under every real violation: a short-circuited null
branch (relative 4874×), a dummy hash baked at drifted parameters (23.7×), a sixth hex character,
and the full digest smuggled as a query parameter. Task 2's defect shape — a parity spec that
stayed green when the thing it guarded was actually broken — was looked for here and found in
exactly two places, F1 and F2, neither of them in the two headline claims. Both are now fixed and
the fixes were proven by re-running the mutations that exposed them.

## Carry-forward rulings

Numbering continues the phase-wide sequence in [`../progress.md`](../progress.md), which ended at
19 after Task 2.

### 20. Argon2 parameters live in configuration, and that is load-bearing for more than tuning

`packages/config/src/env.ts` holds `PASSWORD_ARGON2_MEMORY_KIB`, `PASSWORD_ARGON2_TIME_COST` and
`PASSWORD_ARGON2_PARALLELISM` on `apiEnvSchema` — not on `sharedEnvSchema`, so no web deploy has to
define them to boot. ADR-0014 justifies this as operational tuning, and that is the main reason.
The second reason emerged during the task: **config-held parameters are what let the timing proof
run cheaply enough to live in the unit suite at all.** A constant would have forced that spec into
the integration suite or out of existence.

*Cost if wrong:* an operator who sets these badly now gets a clear config error (Ruling 26); one
who sets them to something merely unwise gets no warning at all.

### 21. `verify()` takes a **nullable** stored hash, and that signature is the security control

`verify(storedHash: string | null, password: string)`. When the hash is `null` it performs a full
Argon2id verification against a dummy hash built in the constructor from live parameters, then
returns `{ valid: false, needsRehash: false }`.

**Task 9 cannot express "no such user, skip the hash" without deliberately not calling this
function.** That is the point of the nullable parameter — an API where the caller decides whether
to fake-verify is an API where the caller eventually forgets. The dummy is seeded from
`randomBytes(32)`, so no user can choose the comparison string.

*Cost if wrong:* if the signature proves awkward at Task 9, wrap it — do not add an overload that
lets the caller skip verification.

### 22. The timing spec runs at **reduced** Argon2 parameters, deliberately, and the reason in the code was wrong before it was right

Ruling 5 of the brief mandated the reduction on the stated grounds that production parameters
"would cost minutes". **That sentence was mine and it was wrong by about 100×.** The reviewer
measured 35.9 ms per verification at the configured defaults on the development machine; the spec
at production parameters would cost roughly 1.9 s, comfortably inside the 5-second budget.

The reduction stands anyway, on a different and now-stated argument: the property under test —
that both paths perform one full verification — is **parameter-independent**, so real parameters
buy CI time and flake risk rather than proof. `ubuntu-latest` is slower and shared, and this phase
already carries one known flaky integration spec.

*Cost if wrong:* if the equalisation ever turns out to have a parameter-dependent component, the
proof is weaker than it reads. Nothing observed suggests it does; the mutation results (4874× and
23.7×) were both obtained at reduced parameters and are not close calls.

**The general lesson, which is the reason this ruling is long:** a decision can be right while the
reason written beside it is false, and the false reason is still a defect. It was caught here only
because the reviewer measured a number that the brief asserted rather than accepting it.

### 23. 250 ms is a documented **target**, never an observed cost

`security/authentication.md` §2 and ADR-0014 give ~250 ms as a tuning target on production
hardware, and ADR-0014 says in as many words that the target is untuned. **No comment, report, or
document may state 250 ms as a measured cost.** Where a cost is stated it carries its own
measurement, its date, and the hardware.

*Cost if wrong:* the same class as carry-forward ruling 11 — a plausible number, repeated until it
is load-bearing, that no measurement supports.

### 24. Timing equality holds against the dummy, **not** against legacy hashes after a parameter raise — Task 9 owns this

The dummy is built at current parameters. Once an operator raises them, a stored pre-raise hash
verifies at the *old*, cheaper parameters until its owner next logs in, while an absent account
verifies against the dummy at *current* parameters. Measured gap between the shipped defaults and
the reduced set: **35.9 ms vs 7.7 ms, 4.6×** — trivially observable across a network.

This is a user-enumeration oracle pointing the opposite way from the one Task 3 proves closed, and
it **opens precisely when ADR-0014's rehash mechanism is used**. It cannot occur today: there are
no accounts, no login path, and no raise has happened. `security/authentication.md` §2 asks for
"login timing equalised whether or not the account exists"; what ships equalises against current
parameters only.

**Binds Task 9.** It is inherent to the design Ruling 21 mandated, not a defect in the
implementation.

*Cost if wrong (i.e. if Task 9 ignores it):* an enumeration oracle that appears on the day an
operator does the responsible thing and raises the parameters.

### 25. A corrupted stored credential is indistinguishable from a wrong password, silently — Task 9 owns this

`runVerification` swallows every argon2 error and returns `false`. The reasoning is correct: the
thrown text derives from the stored hash and must not be logged (critical security rule 6). The
consequence is that a credential the database has corrupted looks exactly like a wrong password
forever — no log line, no counter, no alert.

**Task 9 owns logging it**, where the caller has a user id to attach. A log line saying that a
stored credential failed to parse — no hash, no password, no user-supplied value — is safe and is
the only way anyone would find out.

### 26. `PasswordBreachedError` already exists — Task 8 must not build a second

Built by the implementer without a ruling asking for it, and kept. It ships no route, `check:openapi`
still reports 4, and its spec pins the three things that matter: HTTP 422, the `PASSWORD_BREACHED`
code, and that nothing hex-shaped reaches the message or details. 422 rather than 400 is
`api/conventions.md` §2's rule for a valid shape failing a domain rule.

*Cost if wrong:* mild scope creep in Task 3 against a duplicate class in Task 8. Recorded here
precisely so the duplicate is not built.

### 27. `PASSWORD_BREACHED` is in both lists, and the two lists still have no parity spec

`ERROR_CODES` in `packages/contracts/src/error-codes.ts` and `api/errors.md` §3 both carry it now.
They remain **independent lists with no cross-check** — the same shape as carry-forward rulings 5
and 13, both of which were instances of exactly this drift going unnoticed. Building that parity
spec was out of scope here.

**Any later task adding an error code must add it to both.** A task with spare room should build
the spec; `packages/db/src/enum-parity.spec.ts` is the pattern.

### 28. The breach check is **off** by default, so no downstream task may assume it runs

`PASSWORD_BREACH_CHECK_ENABLED` defaults to `false`. Tasks 8 and 10 must treat a breached password
as a refusal that *may* happen, never as a guarantee that a stored password is unbreached. ADR-0015
also makes it fail open, so even when enabled a HIBP outage means the check silently passes.

**Owed and not built:** a metric and an alert on the rate of fail-open events. ADR-0015 names this
as a real gap rather than a formality — a check that has been failing open for a month is
functionally a check that was removed, and nothing in the current design would surface that.

### 29. `needsRehash` is one-directional and false whenever `valid` is false

A stored hash *stronger* than current configuration is left alone — an operator lowering a number
must not downgrade existing credentials. And a credential that just failed verification is never
rehashed, which would be nonsense. The plan left both undecided; both are now pinned by tests, and
the one-directional half survived the reviewer's mutation J.

### 30. `apiEnvSchema` is now a `ZodEffects` — the same trap as carry-forward ruling 15

F9's fix added a `.superRefine` for Argon2's `m >= 8p`, which turns `apiEnvSchema` into a
`ZodEffects`. **`.extend()`, `.partial()`, `.merge()` and `.shape` are unavailable on it** —
exactly what ruling 15 records for `updateOrganizationRequestSchema`, now true of the API
environment schema as well.

One reader existed and was fixed: the sentinel-leak property test in `env.spec.ts` reads
`.innerType().shape`. The re-reviewer confirmed by whole-repo grep that nothing else reads `.shape`
and nothing extends or merges `apiEnvSchema` (`e2eEnvSchema` extends `webEnvSchema`, not this one).

**Any later task adding an API environment variable must add it inside the base object before the
refinement, not by extending the exported schema.**

*Cost if wrong:* a compile error, not a runtime one — `pnpm typecheck` catches it. Cheap, and
recorded only because the same shape has now bitten twice.

### 31. The `m >= 8p` message uses `too_small`/`too_big`, not a `custom` issue, and that is deliberate

`describeIssue` in `packages/config/src/load-env.ts` never reads `issue.message`, so a `custom`
issue would have printed `failed validation (custom)` and named no rule. The refinement raises
`too_small`/`too_big` with derived bounds instead, which routes through the authored-rule path and
produces two individually actionable sentences naming both variables.

`load-env.ts` was deliberately **not** changed. Giving it a safe `custom` passthrough is a
reasonable future improvement and is a decision for whoever needs a second refinement, not a
side-effect of this one.

### 32. `ARGON2ID` is the literal `2`, and the reason is `isolatedModules`

`@node-rs/argon2` declares `Algorithm` as an ambient `const enum`; `tsconfig.base.json` sets
`isolatedModules: true`, under which a value import of one is a compile error because no runtime
object exists. The literal is pinned by a spec asserting the emitted `$argon2id$` tag rather than
trusted — which is the right way, since the literal is exactly the kind of thing that would drift
silently.
