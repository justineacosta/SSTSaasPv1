# Task 12 review brief — tenant resolution and the authorization guard

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02.

**Review range:** `main..HEAD` on `feat/phase-2-task-12-authorization`, `a0b2963..f4ddb4b` — four
commits. **Plus commit `7540279` on `main`**, Task 11's fix round, which has never been reviewed:
the Task 11 pause state handed it forward as "the author checking their own work", and this is the
task that inherits it.

You are a **fresh adversarial reviewer**. You did not write this code and you owe it nothing.

**One thing about this task's provenance is different and it should change how you read it.** Task
12 is a *gate* in the plan's execution table, so the **orchestrator built it directly** — there was
no implementer subagent and therefore no separation between the person who wrote the code and the
person who wrote the sentences about it. Every rule in this repository about implementers not
writing status prose was structurally unavailable here. **You are the only check that has ever run
over this work.**

---

## 1. Your first pass is citation, not code

Do not open the diff yet.

Phase 1's recurring defect was not bad code — it was **false factual claims in written prose, 12
instances on that branch, 5 of them introduced while correcting an earlier one**. Phase 2 has kept
producing them: Task 11 alone shipped eight false sentences, three inside security controls, and
one was introduced by the orchestrator's own re-verification *in the same commit that falsified
it*.

Open [`report.md`](report.md) and re-verify **every factual claim in it** against the repository
before reading a line of the diff. Run the command. Open the file. `git show` the range.

Then do the same to the prose this task wrote **outside** the report, because that is where the
expensive errors have landed all phase:

- `.claude/product/roadmap.md` — the whole Checkpoint A section, the Phase 2 status row, and the
  rewritten `@RequirePermission()` paragraph.
- `.claude/security/authorization.md` — the new status banner, the layer table in §2, §4's
  no-cache paragraph, §5's rewritten banner, §10's two limits.
- `.claude/api/authorization.md` — the status banner, §2's "what the shipped document actually
  contains", §3's table including the two new rows, §4's corrected example message.
- `.claude/architecture/backend.md` §3 — three rewritten rows, three new rows, the guard-order
  paragraph.
- `.claude/security/authentication.md` §5 — the replaced `requireMfa` bullet.
- `.claude/product/permissions.md` — the invariant-4 rewrite and the "third copy" paragraph.
- `progress.md` — rulings 91–97 and the pause state.

Claims worth attacking first, because they are load-bearing and cheap to overstate:

- **"No shipped route declares `@RequirePermission()`."** This sentence appears in at least seven
  places and the honesty of the whole task rests on it. Verify it against the route inventory and
  the controller files, not against another document that says it.
- **"`check:openapi` still reports 18 routes, because Task 12 shipped no endpoint."** Run it.
- **"Five mutations, all five caught," with the specific counts (9 of 18, 1+1, 4, 1, 1).**
  **Re-run every one of them yourself.** A pasted failure you did not reproduce is a claim, not
  evidence. This is the single most important instruction in this brief, because the orchestrator
  both applied the mutations and wrote the numbers.
- **Ruling 97's caveat** — that the 9 surviving assertions survive *by construction* because 404 is
  the fail-closed direction. Check it. Is it 9? Are they all 404-or-empty expectations? If any
  survivor expects a 200, the caveat is understated and the coverage claim is worse than written.
- **"`prisma migrate deploy` against a fresh empty database fails without the init script."** The
  report gives an SQLSTATE and a migration name. Reproduce it.
- **"Three previously-unregistered guards are now registered, and all three govern zero routes."**
  Two specs were *inverted* by this task — `require-mfa.spec.ts` and
  `email-verified.guard.spec.ts` previously asserted absence. Read both replacements and satisfy
  yourself they cannot pass vacuously. The email-verified one globs the filesystem; the first
  version of it globbed the wrong directory and found zero files, which would have made its claim
  true forever. Is the guard against that sufficient?
- **The numbers in the Checkpoint A evidence table** (91/1553, 113 spec files, 22/380, 15 models,
  18 routes, 5 e2e). Re-run and compare. Task 11's review found a stale count of exactly this kind.

## 2. Then review the code

The whole diff, but these carry the most risk.

- **`resolveTenant` and the layer order.** This is the security model. Can any input produce
  `resolved` when it should not? The `activeOrganizationId === null` branch returns
  `no-active-organization` *before* looking at the membership — is there an input where that is
  the wrong answer? `TenantResolutionInput.membership.isActive` is computed in the store from
  `status === 'ACTIVE'`; is `INVITED` genuinely excluded on every path, and is `REMOVED`?

- **The asymmetry, which is the design decision most likely to be wrong.** `TenantContextGuard`
  denies only when `access.kind === 'permission'`. Every `@AuthenticatedOnly()` route therefore
  proceeds with no tenant. Attack this: is there any route today, or any obvious route Tasks 13–15
  will add, where proceeding without a tenant is a hole rather than a kindness? What happens to a
  handler that reads `request.tenant` on an `@AuthenticatedOnly()` route and forgets it may be
  absent — is the type genuinely load-bearing, or does `exactOptionalPropertyTypes` let it through?

- **`AuthorizationGuard`'s fail-closed path.** It answers **404** when `request.tenant` is absent.
  Is that reachable in any ordering other than a misconfiguration? If a future task registers a
  guard between tenant resolution and authorization that throws-and-catches, does anything break?
  And: `access?.kind !== 'permission'` returns `true` — confirm a fourth arm of `AccessDeclaration`
  is *ignored* rather than *authorised*, and that the test proving it is not itself vacuous.

- **The 403 disclosure.** `permissionDenied` returns `required`, `yourRole` and
  `rolesWithPermission`. `api/authorization.md` §4 permits roles and forbids user names. Is
  anything else leaking — through `DomainError.details`, through the filter, through a log line?
  Can a **non-member** reach a 403 at all? The claim is that they cannot, because layer 2 refuses
  them first with a 404 that says nothing. Prove or break that.

- **`tenantResolver` and the two-layer isolation.** The query runs in `withTenantTransaction` and
  names `organizationId` explicitly. Is the explicit predicate genuinely consistent with what
  `decideScope` injects, or could they disagree? Ruling 75 is the reason
  `authorization.integration.spec.ts` runs as `sentinel_app` — **check that it really does**, and
  that the fixtures are seeded by the owner rather than accidentally by the app role.

- **`mfaEnrolmentPolicy`.** It reads `Organization.requireMfa` inside a tenant transaction and
  `MfaFactor` **outside** one, on the grounds that `MfaFactor` is user-owned with no RLS
  (carry-forward ruling 9). Ruling 9 also says any handler taking a `userId` must prove the caller
  *is* that user. Does this? It takes `userId` from `request.principal`. Is that the proof it
  claims, on every path?

- **`AuthenticationGuard` now writes `request.activeOrganizationId`.** Task 7's ruling E says a
  guard that quietly starts resolving tenants is how the two stages stop being separable. The
  defence written into the docblock is that this is a fact about the *credential*, not a resolved
  tenant. Is that distinction real, or is it a sentence covering a widening? Note the guard sets it
  on a `PENDING_MFA` session too — is that reachable, and does it matter?

- **`@Ctx()` throws a plain `Error` → 500.** Is 500 right, and does the message leak? Is there a
  path where a legitimately-shaped request hits it?

- **Guard order.** Nine now. `app.module.spec.ts` pins it. Are the four "decision" positions
  actually argued correctly, or merely asserted? In particular: the two database-reading gates sit
  *after* the two forgery checks — is there a case where that is wrong? And `EntitlementGuard` is
  last with `canActivate()` taking no parameter at all; confirm that still satisfies `CanActivate`
  at runtime and not just at compile time.

## 3. Specific things to try to break

- Two responses that must be byte-identical: not-a-member and no-organisation. **Verify the
  headers too**, not only status and body — the plan names all three.
- A session whose `activeOrganizationId` points at an organisation that has been **deleted**.
- A membership row that violates the `deletedAt`/`status` CHECK — can one exist, and what does
  `resolveTenant` do with it?
- `knownPermissions` drops unknown keys. Construct the case where dropping is *not* safe, if one
  exists.
- The permission set is a `ReadonlySet`. Can a handler widen it? Is the `Set` shared across
  requests anywhere?
- Concurrency: rulings 74, 84 and 87. A role change committing *during* a request — which side of
  the read does it land on, and is the answer ever "a permission the member no longer holds"?

## 4. Also review commit `7540279` — Task 11's fix round

It has never been reviewed. It closed one High, four Mediums and eight false sentences, and every
change in it was measured by its own author. Treat it as unexamined. The Task 11 pause state and
[`../task-11/fixes.md`](../task-11/fixes.md) are the context.

## 5. How to report

Findings by severity, each with the file and line, what is wrong, and **how you proved it** —
measurement over argument. Where you disprove a claim in a document, quote the claim and give the
command or file that falsifies it. A finding that is a matter of taste should say so.

Do not fix anything. Write the findings; dispositions are the orchestrator's.

Write to `docs/superpowers/ledger/phase-2/task-12/review.md`.
