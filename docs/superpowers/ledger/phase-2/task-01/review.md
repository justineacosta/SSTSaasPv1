# Phase 2 · Task 1 — adversarial review

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-25. Fresh reviewer, no involvement in the implementation. Citation pass before code
pass, per the plan's Execution protocol §3.

## Citation pass

Ten claims from the implementer's reports, re-verified independently. **All ten CONFIRMED** — but
one carried a false sentence around a true measurement, which is the finding below (D3).

The two that mattered most, because both were load-bearing and neither was taken on trust:

- **The partial index is invisible to Prisma.** `prisma migrate diff` output contains zero
  `Membership` statements; migration B mentions `Membership` only in comments. Independently
  re-run by the orchestrator.
- **The re-invite test genuinely fails without migration A.** Proven empirically rather than by
  reasoning: the reviewer reverted a throwaway database to the full unique index and replayed the
  test's exact sequence, getting `duplicate key value violates unique constraint
  "Membership_organizationId_userId_key"`.

The reviewer also confirmed the `has_table_privilege` test is **non-vacuous** three ways: the
function discriminates (`AuditEvent` returns false for UPDATE/DELETE, matching the RLS migration's
`REVOKE`), a renamed table errors rather than returning false, and `expect(rows).toHaveLength(16)`
runs before the loop so a zero-row result cannot pass.

## Findings, and their disposition

| # | Finding | Disposition |
|---|---|---|
| D1 | Migration A was edited after being applied; `migrate dev` now demands a reset | Known; reset pending operator consent. **Sub-finding acted on:** the brief's Ruling 2 named the wrong command — `migrate deploy` does *not* verify checksums; `migrate dev` does. CI and fresh clones were never at risk. Corrected in the brief and in the code comment that had already copied it |
| D2 | Migration B's "EDIT 3" pointed at a warning in migration A that the correction had removed | Fixed |
| D3 | The "`-- This is an empty migration.`" claim was false as written, in three places | Fixed — all three now state the durable narrow claim (zero `Membership` statements) rather than an emptiness that only reproduced under an unstated precondition |
| D4 | **The partial index did not enforce the invariant its comments claimed.** `deletedAt` and `status` were uncorrelated, so two rows for one `(org, user)` could both be `ACTIVE` | Fixed — operator approved a CHECK constraint, `(("deletedAt" IS NULL) = (status <> 'REMOVED'))`, in migration A |
| D5 | The cascade comment overstated itself: `Restrict` on two relations means most users cannot be hard-deleted at all, so the four new cascades fire only for a never-joined account | Fixed; the cascade *choice* was sound and stands |
| R1 | Registering the four tables as deliberately-global exempts them from the CI tenant-scoping check, transferring an obligation to the application layer | Recorded in `tenant-resources.ts` |
| R2 | An abandoned MFA enrolment permanently blocks re-enrolment — `@@unique([userId, type])` counts unconfirmed rows | Carried forward to Task 11 |
| R3 | `secretEncrypted` had no key identifier, so the application key could never be rotated | Fixed — `secretKeyVersion` added |
| R4 | No sweep index on `VerificationToken.expiresAt` | Carried forward |
| N1 | The docstring-example vacuity guard asserts `> 0`, not a count | Noted; non-vacuous today (exactly one example) |
| N2 | Neither migration uses `CONCURRENTLY` | Known deferral; Prisma cannot express it in a transactional migration |
| N3 | `roadmap.md`'s "residuals owed to Task 1" note unfulfilled | Orchestrator's, done in this change |

## The reviewer's verdict on the four open design questions

- **`ID_PREFIXES` deferred to Task 2** — correct, and the reviewer found something the plan missed:
  there are **two** independent prefix registries, `packages/db/src/id.ts` and
  `packages/contracts/src/ids.ts`, with no cross-check. Task 2 must extend both. Also, the plan
  names four prefixes for five new models — `IdentityProviderLink` has none, and `parseIdPrefix`
  hard-codes three characters.
- **`Session.status` with no `@default`** — *"the strongest single decision in the change."* Keep it.
  The constraint arrives before the code, which is the right order.
- **`rotatedFromId` as a plain column** — agree. A dangling ID is more useful than a null breadcrumb
  during an incident. One sentence should be added telling a future reader not to "fix" it.
- **The hardcoded table list** — keep. The registry is a list of *models*; the test is about *tables
  this task created*, and those sets diverge the moment another global model lands.

## The reviewer's headline, quoted because it is the lesson

> The code is good — the schema, both migrations, the cascade reasoning, and the two new tests all
> hold up under attack. What did not hold up is the prose, in the same way and for the same reason
> as Phase 1: correcting a claim in place, after the artefact was applied, produced a checksum break
> and two stale cross-references — **five new wrong sentences introduced while fixing one**, which
> is precisely the Phase 1 pattern the citation pass exists to catch.
