# Phase 2 · Task 3 — brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Written by the orchestrator before dispatch.

**Task:** Password hashing and the breach check.
**Plan section:** `docs/superpowers/plans/2026-08-24-phase-2-identity.md`, "Task 3".
**Mode:** fresh implementer subagent + separate adversarial reviewer. Task 3 is one of the five
self-contained tasks (1, 3, 4, 5, 11) in the plan's Execution protocol §2. **It is not chained to
any task.** Tasks 8, 9 and 10 depend on its output; nothing runs alongside it.
**Branch:** `feat/phase-2-task-03`, cut from `main`. PR #5 was rebase-merged on 2026-08-25 at
04:37Z, so `feat/phase-2-identity` is spent history with an identical tree; do not use it.

## What the previous task left, and what was re-verified before dispatch

Task 2 was re-verified by this session on `main` rather than taken from its report. All exit 0:
`pnpm format:check`, `pnpm lint` (14 tasks), `pnpm typecheck` (14 tasks), `pnpm test`
(**43 files / 536 tests**), `pnpm check:specs` (54 spec files), `pnpm check:openapi`
(**4 routes**), `pnpm check:registry` (14 models), `pnpm build` (8 tasks), `pnpm test:integration`
(**11 files / 148 tests**), `pnpm test:e2e` (5 passed), `docker compose ps` (all four healthy).

Carry-forward rulings **11** and **16** in [`../progress.md`](../progress.md) bind this task
directly, and **14** binds it if it touches error codes (it does — see Ruling 3).

**Ruling 11 is the one to read twice.** `passwordSchema` in `packages/contracts/src/auth.ts`
already fixes the policy at `.min(12).max(256)`. **Task 3 hashes; it does not redefine the rule.**
Do not modify `passwordSchema`, `PASSWORD_MIN_LENGTH` or `PASSWORD_MAX_LENGTH`. And do not repeat
the phrase "no maximum below 128" anywhere — it is attributed to `security/authentication.md` §2
and that document does not contain it (`grep -rn "128" .claude/`). The 256 ceiling's justification
now lives in ADR-0014.

## Decisions already made — read these, do not re-derive them

[**ADR-0014**](../../../../../.claude/decisions/ADR-0014-argon2-implementation.md) and
[**ADR-0015**](../../../../../.claude/decisions/ADR-0015-password-breach-check-fails-open.md) were
written and committed (`17d6595`) **before this dispatch**, deliberately. They are Accepted and
immutable. Read both before writing code. **You do not write ADRs and you do not edit these.**

## Orchestrator rulings taken before dispatch

Eight places where the plan's text does not resolve against what is in the repository. Each is
recorded with the cost if the ruling is wrong. **The implementer follows these; it does not
relitigate them.** If one turns out to be impossible, stop and report — do not silently choose
differently.

### Ruling 1 — create `modules/auth/` with a module and no controller

`apps/api/src/modules/` contains only `health` today. Task 3 creates `modules/auth/` with
`auth.module.ts`, `password.service.ts`, `breach-check.service.ts` and their specs, following the
shape of `modules/health/`.

**`AuthModule` has no controller and registers no route.** It exports the two services for Tasks 8,
9 and 10 to consume.

*Why:* `pnpm check:openapi` must still report **4 routes** when you are done. A route appearing
here would be an unauthenticated, unguarded endpoint shipped six tasks before the guard that
protects it (Task 7).

*Cost if wrong:* if Nest complains about a provider-only module, say so — but it will not; that is
an ordinary Nest shape.

### Ruling 2 — configuration goes in `apiEnvSchema`, not `sharedEnvSchema`

`packages/config/src/env.ts` splits shared / api / web / e2e. Argon2 parameters and the breach flag
are API-only. Add to **`apiEnvSchema`**, and add matching lines to `.env.example`.

Names, fixed here so Tasks 8–10 can rely on them:

| Variable | Type | Default |
|---|---|---|
| `PASSWORD_ARGON2_MEMORY_KIB` | int | `65536` (64 MiB) |
| `PASSWORD_ARGON2_TIME_COST` | int | `3` |
| `PASSWORD_ARGON2_PARALLELISM` | int | `4` |
| `PASSWORD_BREACH_CHECK_ENABLED` | boolean-from-string | `false` |
| `PASSWORD_BREACH_CHECK_TIMEOUT_MS` | int | `2000` |
| `PASSWORD_BREACH_CHECK_RANGE_URL` | url | `https://api.pwnedpasswords.com/range` |

Reuse the existing `booleanFromString` helper. The flag defaults to **`false`**, which satisfies
the plan's "default false in `test`" without a test-environment special case — an environment that
wants the check on turns it on explicitly.

*Why:* `apps/web/src/env.ts` parses its schema at module load in every environment. A variable
added to the shared schema becomes one every web deploy must define in order to boot. The comment
above `e2eEnvSchema` records that exact reasoning for `E2E_PORT`; this is the same rule.

*Cost if wrong:* moving a variable between schemas later is a one-line change plus `.env.example`.
Low.

### Ruling 3 — the error code is `PASSWORD_BREACHED`, added to both lists

No breach code exists. Add `PASSWORD_BREACHED: 'PASSWORD_BREACHED'` to the **Validation** group of
`ERROR_CODES` in `packages/contracts/src/error-codes.ts`, and to the **Validation** line of
`.claude/api/errors.md` §3. Both, in this task.

It maps to **HTTP 422** — `api/conventions.md` §2: "Valid shape, failed a domain rule". Not 400.

Its message must say how to succeed, per `errors.md` §4: name that the password appears in a public
breach corpus and ask for a different one. **Never echo the password, any part of it, or any part
of its hash into the message.**

*Why Validation rather than Auth:* the Auth group is about authentication attempts failing. This is
a policy refusal of a submitted value during registration or change.

*Why both lists:* they have no parity spec between them. Carry-forward rulings 5 and 13 are both
instances of exactly this drift going unnoticed. **Building that parity spec is not your task** —
adding the code to both lists is.

*Cost if wrong:* renaming a never-raised error code is cheap now and expensive after Task 8 ships
an endpoint that returns it.

### Ruling 4 — the timing-equality primitive ships here; Task 9 wires it

The plan says "the login path must still perform a full Argon2id verification against a fixed dummy
hash". **There is no login path at Task 3** — Task 9 owns it.

Ruling: `password.service.ts` exposes a verification entry point that **takes a nullable stored
hash** — `verify(storedHash: string | null, password: string)` — and, when the hash is `null`,
performs a full Argon2id verification against a fixed dummy hash before returning
`{ valid: false, needsRehash: false }`.

**The nullable parameter is the design.** It makes the safe path the only path: Task 9 cannot
express "no such user, skip the hash" without deliberately not calling this function. An API where
the caller decides whether to fake-verify is an API where the caller eventually forgets.

The dummy hash is generated **once at service construction, from the current configured
parameters** — not a hard-coded constant. A dummy baked at different parameters than live hashes is
a timing oracle wearing a mitigation's name.

*Cost if wrong:* if Task 9 finds the signature awkward it can add a wrapper; the primitive and its
timing proof stay valid.

### Ruling 5 — the timing spec runs at reduced Argon2 parameters, and asserts medians

Argon2id at the configured 64 MiB / t=3 targets ~250 ms per verification. A statistical test needs
N samples on each of two paths; at production parameters that is minutes, and the whole unit suite
currently runs in **4.21 s**.

Ruling: the timing spec constructs the service with **deliberately reduced parameters** (this is
possible precisely because Ruling 2 puts them in config, and is the first real payoff of ADR-0014's
config decision), takes **N ≥ 15** samples per path, and asserts the **medians** are within a
stated relative tolerance. Write the tolerance and the reason for its value in a comment.

**Budget: the whole spec finishes in under 5 seconds.** If it cannot, report that rather than
raising the timeout.

The property under test — that both paths perform one full verification — is parameter-independent,
which is what makes the reduction sound rather than a cheat. Say so in the comment.

*Why medians, and why not strict equality:* the plan says it outright. "A strict equality assertion
here is a flaky test, and a flaky security test gets deleted." This branch already carries one
known flaky integration spec; do not add a second.

*Cost if wrong:* a tolerance set too loose passes a real regression. Justify the number you pick
against the spread you actually observe, and put the observed spread in your report.

### Ruling 6 — the HIBP transport is injected, and the 5-character assertion is the deliverable

Define a narrow transport port (a function type is enough — do not build a framework) that the
service takes as a dependency. **No spec may touch the network.**

The spec that asserts the outbound URL carries **exactly five hex characters** of the SHA-1 and
nothing else **is the whole privacy claim of ADR-0015**. Write it so it would fail if someone later
sent the full digest: assert the exact URL string, not a substring match.

Send the `Add-Padding: true` request header. **If you cannot confirm from HIBP's own documentation
that this header is honoured, still send it — it is harmless — but write no comment claiming an
effect you did not verify.** Unverified sentences are this phase's recurring defect, not its
commands.

*Cost if wrong:* a transport port that turns out to be the wrong shape is a small refactor at
Task 8. An unpinned privacy claim is a security defect.

### Ruling 7 — fail open means log and continue, and the log must be safe

On any error, timeout, non-200, or unparseable body: log at `warn` via the redacting logger from
`@sentinel/observability` (`createLogger`) and **return "not breached"**.

**Do not log the password. Do not log its SHA-1. Do not log the 5-character prefix either** — the
prefix narrows the candidate space and it buys nothing diagnostically. Log the failure reason and
the elapsed time. `console` is banned by lint and `any` needs a written justification comment;
both rules bite in this file.

Each of these is a test: assert the fail-open return value on timeout, on a 500, and on a garbage
body.

*Cost if wrong:* a logged prefix is a permanent artefact in a log aggregator. Critical security rule
6 has no exceptions.

### Ruling 8 — write the rehash test first, and prove it goes red

The plan says it: hash with weak parameters, raise config, verify, assert `needsRehash` is true and
that the stored hash is replaced. Write it before the implementation.

Additionally, **prove the negative**: hashing at current parameters and verifying immediately must
report `needsRehash: false`. A `needsRehash` that is always true silently rehashes on every login,
which is a 250 ms tax per request that no test would catch.

*Cost if wrong:* this is the mechanism that makes ADR-0014's "parameters can be raised later" true.
If it does not work, the ADR is describing something that does not exist.

## What "done" looks like

Every command below run, with its real exit code captured **outside a pipe**
(`out=$(pnpm <cmd> 2>&1); code=$?` — `$?` after a pipe reports the last stage, not the command):

`pnpm format:check` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm check:specs` ·
`pnpm check:openapi` · `pnpm check:registry` · `pnpm build` · `pnpm test:integration`

`pnpm check:openapi` must still say **4 routes**. `pnpm check:specs` must claim every new spec.

`pnpm test:e2e` is not required — this task cannot reach a rendered page — but say so in your report
rather than omitting the row.

**Note for your report:** `@node-rs/argon2@2.1.0` was published 2026-08-13, twelve days clear of
ADR-0013's 1440-minute cooldown, so `pnpm install` should not hit `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
If it does, stop and report — do not add a `minimumReleaseAgeExclude` entry. ADR-0013 forbids it.

## Rules on what you write

From the plan's Execution protocol §3, and they are not negotiable:

- **Report commands and exit codes, not prose.** No status sentences.
- **Do not edit `roadmap.md`.** Do not write `.claude/` narrative. The one exception is the two
  mechanical edits Ruling 3 requires in `api/errors.md` §3 and Ruling 2 requires in `.env.example`.
- **Do not write or edit an ADR.** Both are already committed.
- Every factual claim in your report names the command or the file and line that establishes it.
  Verify before you assert — including when you are correcting something you said earlier.

Documentation ships in the task that makes it false. If your change makes a sentence in
`.claude/security/authentication.md` or `.claude/api/errors.md` untrue, **report it**; the
orchestrator writes the replacement sentence.
