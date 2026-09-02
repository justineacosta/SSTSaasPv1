# Task 13 fix round — dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Orchestrator, 2026-09-02, on the findings in [`review.md`](review.md). Every code finding is
dispositioned below. The fix round has **not itself been reviewed** — the same status Tasks 10, 11
and 12's carried.

## Summary

| # | Finding | Disposition |
|---|---|---|
| **H1** | `SET search_path = public` leaves the definer function open to a `pg_temp` hijack | **Fixed**, and superseded by ADR-0021 |
| **M1** | `pnpm test:integration` non-deterministic — TOTP step-boundary flake | **Accepted, not fixed.** Outside the range; recorded |
| **M2** | Matrix cannot detect a single guarded route being downgraded | **Accepted as assessed.** Coverage documented, not changed |
| **M3** | Arm 3 never reaches the handler, so it does not test what it says | **Fixed**, and the fix proved by mutation |
| **L1** | A cursor JS accepts and Postgres rejects turns a 400 into a 500 | **Fixed** |
| **L2** | Blockquote continuation lines lost their `>` prefix | **Fixed** |
| — | Seven false claims in the citation pass | **Fixed**, plus five more the review did not find |

## H1 — the `pg_temp` hijack. Fixed.

**Reproduced independently before accepting it.** The reviewer's transcript is not what closed
this; the orchestrator re-ran the attack against the live database and got the same result, then
proved the fix in the same session:

```
=== HIJACK: shipped function, search_path = public ===
      id      |   slug   |   name   | status
--------------+----------+----------+--------
 org_probe_d2 | probe-d2 | Probe D2 | ACTIVE
(1 row)
=== control: same role, direct read of the real Organization ===
 direct_org_reads: 0

=== VULNERABLE (search_path = public) ===        rows_returned: 1
=== FIXED (search_path = public, pg_temp) ===    rows_returned: 0
```

A role whose own reads of both tables return zero rows obtained a real `Organization` row for a
user with no membership, by shadowing `Membership` with a temp table. The predicate in the function
body was applied faithfully — to the wrong table.

**Fixed by migration `20260902130000_organization_lookup_search_path`**, a new migration rather than
an edit to the applied one (carry-forward ruling 2: editing an applied migration breaks
`prisma migrate dev` on every clone while `migrate deploy` and `migrate status` do not notice).
Applied locally, `EXIT=0`; `proconfig` now reads `{"search_path=public, pg_temp"}`, and re-running
the attack against the shipped function returns **0 rows**.

**[ADR-0021](../../../../.claude/decisions/ADR-0021-definer-search-path-pins-pg-temp-last.md)
supersedes ADR-0020** rather than editing it. The decision — one definer function, one dedicated
`BYPASSRLS` owner — is unchanged; one of the four containment properties it rested on was false, and
this directory's rule is that an accepted ADR is superseded, never edited. ADR-0020's false sentence
stays visible in the record.

**The assertion now pins the rule, not just the value.**
`migration.integration.spec.ts` asserted `proconfig` equalled `['search_path=public']` — the pin was
right and the value pinned was the vulnerable one, with a comment asserting the opposite. It now
asserts equality *and*, separately, that `pg_temp` is present and is **last**, so a later edit that
keeps `pg_temp` but moves it earlier fails with a message naming the actual rule.

**Not done:** `TEMPORARY` is still granted to `PUBLIC`. That is defence in depth against the class
rather than the instance, and a database-wide privilege change deserves its own decision. Recorded
as a residual in `security/tenant-isolation.md`.

## M3 — arm 3 never reached a handler. Fixed, and the fix is measured.

The stranger's session pointed at an organisation they had no membership in, so
`TenantContextGuard` answered 404 before any handler ran. The arm passed, recorded itself as
exercised, and never evaluated the path-id substitution it exists to probe.

**Fixed** by giving the stranger a real `ACTIVE` membership in the organisation their session points
at, so the guard resolves, the permission check passes, and the only thing wrong is that the path
names a different organisation.

**The fix found a second defect immediately.** With a valid membership the arm reached `PATCH` and
got **400** — the empty body was rejected by `ZodValidationPipe`, which runs *after* the guards but
*before* the handler, so the tenant check still never ran. Closed with a `bodyFor()` registry
following the same shape as the existing `substitutePathParameters`, plus an explicit failure in arm
3 when a 400 comes back, naming the registry. A future guarded route needing a body cannot pass this
arm by accident.

**Proved by mutation.** Neutering `assertPathIsActiveTenant` — the mutation under which the old arm
3 stayed green:

```
arm 3 — answers 404 to a member of a different tenant   FAILED
+   "DELETE /api/v1/organizations/:id answered 409 cross-tenant, expected 404"
+   "GET /api/v1/organizations/:id answered 200 cross-tenant, expected 404"
+   "PATCH /api/v1/organizations/:id answered 200 cross-tenant, expected 404"
Test Files  1 failed (1)   Tests  1 failed | 11 passed (12)
```

All three routes, where the old arm caught none — and the 200s show what the mutation actually costs:
a cross-tenant read and a cross-tenant write. Mutation reverted; `git diff` on
`organization.service.ts` is empty.

## L1 — cursor 500. Fixed.

`Date` and Postgres disagree on what an ISO timestamp is, and `Date` is more permissive:
`new Date('2026')` is valid, `SELECT '2026'::timestamptz` is a syntax error. The code validated with
`Date` and passed the **client's original string** to the query, so `{"createdAt":"2026"}` answered
500 where `api/errors.md` says 400 — through a path the docblock claimed was closed.

**Fixed** by returning `new Date(createdAt).toISOString()`: the value handed to Postgres is one this
code produced, in a format Postgres accepts by construction. Two unit tests added — one that the
hostile value is re-serialised, one that an already-canonical timestamp is left byte-identical so
paging stays stable. `pnpm test` 1626 → **1628**.

The general rule is written into the docblock because it generalises past this function: **when two
parsers must agree, do not validate with one and pass the input to the other — validate with one and
pass its output to the other.**

## M1 — the integration flake. Accepted, not fixed.

A TOTP step-boundary race in `auth.mfa.integration.spec.ts`, **outside this change range**, which
the reviewer hit once and which passes in isolation. It did not reproduce across three subsequent
full runs here (440/440, three times). It is real, it is not Task 13's, and it will surface in CI —
**where it must not be misdiagnosed as a Task 13 regression.** Recorded in the roadmap's known-issues
list and owed to whoever next touches the MFA suite.

## M2 — the matrix's blind spot. Accepted as assessed; no code change.

The matrix iterates the guarded set, so a route downgraded from `@RequirePermission()` to
`@AuthenticatedOnly()` leaves the set rather than failing an arm. The replaced sentinel catches the
set going *fully* empty, which is the systemic failure; a single downgrade is caught by
`organizations.controller.spec.ts`'s per-route access table and the scoped spec's 403 arm.

The reviewer ran the mutation the implementer did not — downgrading `organization.read`, the route
with no possible 403 arm — and found it goes **1 unit + 3 integration** red, not the 1+1 the report
implied for the general case. **The compensating coverage is stronger than the report claimed**, and
`security/authorization.md` now states the limit and what covers it rather than leaving it to the
ledger.

## L2 and the citation pass

Three blockquote continuation lines had lost their `>` prefix in the banners this task rewrote —
harmless today through Markdown lazy continuation, a silent banner split after any later edit.
Fixed in `.claude/api/authorization.md` and `.claude/security/authorization.md`.

**The stale "no shipped route declares `@RequirePermission()`" sentence was in more places than
either party found.** The report disclosed 3 (all in `roadmap.md`); the review found 2 more and said
5; **the orchestrator then wrote "eleven", from memory of the files it had edited, and that was
wrong too.** Counted mechanically instead — one `git grep` for the sentence family over `.claude/`
and `apps/api/src/` at `1310604` — it is **fourteen lines across nine files**, plus a tenth
(`auth-harness.ts`) whose wording escaped that grep. Among them were four rows of
`architecture/backend.md`'s pipeline table that neither the implementer nor the reviewer opened —
Tenant resolve, Authorize, Email verified and MFA enrolment, each asserting a state Task 13 had
falsified. All are corrected. The `roadmap.md` sites are corrected in the status change itself.

**Three parties stated this count and all three were wrong; the grep was right the first time.**
That is ruling 108 demonstrating itself on the very finding that produced it, and it is the reason
the ruling says *compute*, not *check carefully*.

Also corrected: `audit.actions.ts`'s "All four actions above" (the file holds three — the same
miscount `security/audit.md` carried, twenty-one lines below the constant it miscounts); the matrix
spec's docblock, which described the empty guarded set, named a test that no longer exists, and put
Task 13 in the future tense fifteen lines above a test asserting the opposite; and seven
`until Task 13` comments left asserting in the present tense that nothing writes
`Session.activeOrganizationId`.

**The lesson, recorded as a ruling.** Three separate parties wrote or reviewed a sentence stating a
count in this task, and all three got a count wrong. The defence that worked every time was
mechanical: extract the list and count it. Reading the list and agreeing with it failed every time.

## Verification after the fix round

Re-run on the finished tree, exit codes captured outside a pipe:

| Command | Exit | Figure |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm test` | 0 | **95 files / 1628 tests** (1626 + 2 cursor tests) |
| `pnpm check:specs` | 0 | 120 spec files |
| `pnpm test:integration` | 0 | **25 files / 440 tests** |
| `pnpm build` | 0 | 8 tasks |
| `pnpm check:openapi` | 0 | byte-identical, 21 paths / 24 operations |
| `pnpm check:registry` | 0 | 15 models |
| `pnpm check:secrets` | 0 | 433 tracked files |

`pnpm test:e2e` not run — no `apps/web` path touched in this range. CI has not run; nothing pushed.
