# Task 17 — adversarial reviewer's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-07 after the implementer reported. Branch
`feat/phase-2-task-17-app-shell`, commits `6118952..0b4c279`, base `5dbab4e` on `main`.

## Your first pass is citation, not code

Execution protocol §3. **Before you open a diff**, re-verify every factual claim in
`task-17/report.md` against the repository — run the command, open the file, `git show` the range.
This project's recurring defect is false sentences about code, not bad code: twelve in Phase 1, ten
across Tasks 14–15, five in Task 16's report.

**Two things you should know rather than discover, so you spend your budget on what is unknown:**

1. **The orchestrator's own brief contained a false claim, and the implementer caught it.** §2 of
   `brief.md` said "These routes are authenticated, so `perPrincipal` does resolve." It does not:
   `RATE_LIMIT_SCOPE_PHASES` puts `perPrincipal` in the `'edge'` phase and the docblock above it
   states that with `principalSource: 'authenticated'` it "still resolves nothing" (rulings 55 and
   90). Verified by the orchestrator at `rate-limit.config.ts:371-381`. The implementer's
   correction stands; **what you must check is what it built on that basis** (see §3 below).
2. The measured pre-task baselines are `pnpm test` **109 / 1882**, `check:specs` **137**,
   `test:integration` **28 / 521**, `check:openapi` **27**, `check:registry` **15**, `test:e2e`
   **22**. Task 16's report got its baseline wrong by deriving it; check whether this one's
   claimed numbers reproduce.

## §1. The security surface that did not exist a day ago — spend most of your time here

Three new authenticated endpoints, and they revoke credentials:

```
GET    /api/v1/auth/sessions
DELETE /api/v1/auth/sessions/:sessionId
DELETE /api/v1/auth/sessions
```

- **Cross-user isolation is the single most important property in this task.** Another user's
  session id must answer **404, never 403** — 403 confirms the id exists. Do not accept the
  integration test as proof it holds; try to defeat it. A well-formed id for a live session of
  another user, an id that exists but is already revoked, an id from a different prefix namespace,
  a malformed id, and the caller's *own* id after they have been revoked.
- **`tokenHash` must appear in no response.** The implementer reports **three** independent
  strippings (service projection, controller mapping, response schema) and that one mutation
  widening a single layer **survived the integration lane** because the others covered it. That is
  defence in depth and it is also a blind spot: confirm the schema is the actual enforcer, and
  check whether anything else — an error path, a 404 body, a log line, the audit metadata — can
  carry a hash or a token.
- **`DELETE /auth/sessions` must not revoke the current session.** Verify `exceptSessionId` cannot
  be undefined, empty, or the wrong id on any path, and that the caller is still authenticated
  afterwards.
- **Revoking the current session is permitted by design** (implementer's decision 1) and clears
  both cookies. Check the end state genuinely matches `POST /auth/logout` — a half-cleared cookie
  pair is a signed-in-looking app that 401s on everything.
- `check:registry` must still report **15 models**. `Session` is user-owned, not tenant-owned. If
  it has drifted into the tenant registry, that is a finding.

## §2. The audit deviation — the implementer departed from a CLAUDE.md rule and said so

`CLAUDE.md` rule 10: **"Security-relevant actions write an audit event in the same transaction as
the change."** The implementer's decision 2 does **not** do that. Its argument: `SessionService`'s
revocation spans Redis and Postgres with a tombstone-before-write ordering and takes no transaction
handle, so it revokes and then audits — the same compromise `logout.service.ts` already documents
in that module.

**Judge this on the merits, adversarially. It is the highest-stakes judgement call in the task.**

- Is the precedent real? Open `logout.service.ts` and confirm it does what is claimed, and that its
  reasoning transfers rather than merely resembling this case.
- What is actually lost? Construct the interleaving: process dies between revoke and audit. Is the
  result a revoked session with no audit trail — and how bad is that for an append-only security
  log that an incident review depends on?
- The implementer claims it is **stricter** than `logout` because a row is written only when a row
  actually moved, so a replayed revocation cannot pad the table. Verify that, do not accept it.
- Could it have been in a transaction? Say so concretely if yes.
- If you judge the deviation acceptable, **say so plainly** — a rule with a documented, reasoned
  exception is healthier than one silently broken. If not, say what breaks.

## §3. The rate-limit choice, built on the corrected fact

`generalSession` on all three routes. Given the correction above, `perPrincipal` resolves nothing
and `generalSession` is fail-open — so **these three credential-revoking endpoints are effectively
unlimited**. The implementer argues that is right: `perIp` classes are all fail-closed, and failing
closed on a *defensive* action during an incident is the wrong direction; no secret is verified;
every refusal is the same 404, so there is no oracle.

Test that argument. Is an unlimited `DELETE /auth/sessions` abusable by someone who already holds a
session? What does it cost the system? Is the "no oracle" claim true of **every** response
including timing and the paginated list?

## §4. The rest

- **Cache clear on organisation switch.** `frontend.md` §3 requires the cache **cleared entirely**,
  not selectively invalidated — stale tenant data under a new organisation is a tenant-isolation
  failure the user can see. The implementer reports mutations killing both the removal and a
  selective substitute. Verify the clear is total and that nothing survives it (router cache,
  in-flight requests, an unmounted component's stale closure).
- **`usePermission` / `<Can>` must be UX only**, with a docstring saying so in those words. Confirm
  no code path treats either as a control, and that every gated affordance is still refused
  server-side.
- **The 401 → login redirect** must use Task 16's `isSessionExpiry` and `loginHrefForDestination`,
  not a second helper. `safeRedirectPath` is a security control that Task 16's review found broken
  once; confirm it is untouched (`git diff 5dbab4e..HEAD -- apps/web/src/api/redirect.ts` should be
  empty) and that the shell cannot route around it.
- **The new `qrcode` dependency.** Encoding only, rendered as React `<rect>`s per the report — so
  no library output should reach an HTML parser. Verify that, and verify ADR-0013's 1440-minute
  floor was satisfied rather than bypassed (`pnpm-workspace.yaml` unchanged; the report mentions an
  `--ignore-scripts` install after an EPERM on the Prisma engine — check that left the lockfile
  honest).
- **Recovery codes** must be shown with a plain statement that they will not be shown again.
- **`/dashboard` must contain no mock product UI** — no fake metrics, no placeholder charts.
- **The `PENDING_MFA`/expired exclusion from the list** (decision 5): confirm those sessions really
  cannot authenticate a request, or the list is hiding live credentials from their owner.

## §5. Documentation the change makes false — report, do not fix

The implementer lists `frontend.md` §2's table row and banner, `api/authentication.md` §7's
rate-limit table, `api/authorization.md`'s banner, and `ui-ux/page-map.md`. **Verify that list is
right and complete** — a missed document is the defect, and the orchestrator writes all of them.

## Your own rules

- **Write `task-17/review.md` from your first few minutes and commit incrementally.** Ruling 131:
  a reviewer that finished its passes and wrote nothing lost an entire review.
- Every finding: severity, precise citation, and a **measurement** that proves it. "This looks
  wrong" is not a finding.
- List separately what you checked and found **fine** — a review reporting only problems gives no
  signal about coverage.
- You may run anything. You may **not** fix anything, and you may not edit `.claude/`.
- Never commit to `main`. Messages end:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
