# Task 11 review brief — TOTP MFA and recovery codes

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02. Review range: `main..HEAD` on `feat/phase-2-task-11`,
`cc81494..9513d97` — seven implementer commits plus the brief and the report.

You are a **fresh adversarial reviewer**. You did not write this code and you owe it nothing.

---

## 1. Your first pass is citation, not code

Do not open the diff yet.

Phase 1's recurring defect was not bad code — it was **false factual claims in written prose, 12
instances on that branch, 5 of them introduced while correcting an earlier one**. Phase 2 has kept
producing them: Task 10's reviewers found the sentence explaining a fix naming the wrong mechanism,
a ruling number cited for a proposition it does not contain, and a document sentence claimed by the
code and absent from the diff.

So: open [`report.md`](report.md) and re-verify **every factual claim in it** against the actual
repository before reading a line of the diff. Run the command. Open the file. `git show` the range.
The orchestrator already re-ran the eleven verification commands and already caught one stale number
(`check:secrets` at 389 against 404) — that is the *class*, not the total, and finding it does not
mean the rest were checked. Assume they were not.

Claims worth attacking first, because they are load-bearing and cheap to overstate:

- "**RFC 6238 Appendix B — all 18 rows, all three algorithms.**" Open the spec. Are all 18 there? Are
  the SHA-256 and SHA-512 seeds actually the longer ones, or the 20-byte seed reused, which would
  make those rows pass against a wrong implementation? Is the step column derived as claimed, or
  transcribed?
- "**RFC 4648 §10 — all 7 vectors.**" Same treatment.
- "**The predicate is two-stage.**" Read it. Does the second stage do what the report says?
- "**Registered in no module.**" The report says a spec asserts this by stripping comments first.
  Read the spec and satisfy yourself it cannot pass vacuously.
- "**Always padded to exactly ten.**" Count the verifications on every path, including the one where
  the user has spent nine codes.
- The **migration is not applied** and the SQL in the report matches the file on disk byte for byte.

## 2. Then review the code

The whole diff, but these carry the most risk:

- **`mfa/verify` and the pending-session promotion.** This is the privilege-raising path in the
  entire task. Rulings 50, 82 and 83. Can any interleaving produce an `ACTIVE` session that should
  not exist? Can a `PENDING_MFA` token reach anything other than this route?
- **The replay defence, and the report's own honest limit.** The implementer states plainly that the
  concurrent endpoint probe proves *at least one* layer refuses, not which, and that widening the
  `UPDATE` predicate leaves both the sequential and the concurrent endpoint tests green. Take that
  seriously: it means an endpoint-level test would not catch a regression in the database-level
  control. Is the statement-level probe sufficient? Is the in-memory floor load-bearing or is it
  masking the column?
- **Concurrency, everywhere.** Ruling 74, and ruling 84 which is ruling 74 recurring *inside a fix
  round for a finding whose dispositions cite ruling 74*. The attempt counter, the replay step and
  the recovery-code spend are all read-check-write. The implementer pasted red results from removing
  each guard. **Re-run those mutations yourself** — a pasted failure you did not reproduce is a
  claim, not evidence.
- **The timing oracles.** Recovery vs TOTP is ~1 ms against ~2.5 s and the report argues it
  discloses nothing because the caller chooses which kind to send. Test that argument rather than
  accepting it. Is there any path where the *server* chooses, or where the code's length is
  attacker-influenced into crossing the branch?
- **Enumeration and error shape.** Does a wrong code, a used recovery code, a locked pending
  session, an expired pending session and a promoted-then-revoked session all answer the same way?
- **The encrypted secret.** Wrong key, tampered ciphertext, tampered auth tag, wrong version — does
  each fail closed? Does the secret appear in any log line, error body, OpenAPI example, or test
  snapshot?
- **Ruling 7's fix.** Enrol, abandon, enrol again. Enrol over a *confirmed* factor. Concurrent
  enrolments.
- **Ruling 85.** No security notice may render a stored display name. Check the two new callers and
  the new-device notice on the MFA arm.
- **Audit rows in the same transaction as the change**, not after it and not best-effort. Check the
  rollback path actually leaves no row.
- **Every route declares its access**, and the boot assertion still cannot pass vacuously.

## 3. The six gaps the implementer already declared

These are **disclosed, not hidden**, and the disclosure is worth something. Your job is to judge
whether each is correctly *sized* — a real defect described as a cosmetic one is a finding; so is a
gap that is actually larger than stated.

1. The promoted session is always 7 days, never 30 — `rememberMe` is lost between the pending arm
   and the rotation.
2. **Recovery-code regeneration sends no email.** An attacker with a stolen session and the password
   silently invalidates the owner's printed codes.
3. Disable revokes no sessions.
4. The recovery path costs roughly 12.5 s of CPU per login before the lock engages.
5. The attempt counter is per pending session, so re-authenticating grants a fresh five.
6. `@AllowPendingMfa()` is inert on the shipped route.

Number 2 and number 5 look to the orchestrator like the two most likely to be undersized. Number 4
is a denial-of-service surface on an unauthenticated-adjacent endpoint and deserves an explicit
verdict rather than a shrug.

## 4. What to hand back

`docs/superpowers/ledger/phase-2/task-11/review.md`, containing:

- **A findings index** — one row per finding, with a severity (High / Medium / Low) and a one-line
  claim.
- **One section per finding**: what is wrong, the **measurement or citation that proves it**, the
  cost if it ships, and a recommended disposition. An argument is not a proof — Task 10's High was
  accepted because 25 of 25 survivors were counted, not because it was reasoned.
- **A separate section for false or unsupported sentences** in `report.md`, `brief.md`, the ADR, the
  migration comment, or any `.claude/` document this branch touched. This is a first-class finding
  class here, not a footnote. The brief itself is fair game: the orchestrator wrote it and it has
  been wrong before.
- **A verification table** of what you ran yourself, with real exit codes captured outside a pipe.
- **An overall verdict**, and be willing to make it negative.

Do not fix anything. Findings only — the orchestrator dispositions them and a fix round follows.

You are on branch `feat/phase-2-task-11`. Do not commit, do not push, do not modify source files.
If you need to mutate code to prove a defect, revert it and say so explicitly, pasting the output
from both states.
