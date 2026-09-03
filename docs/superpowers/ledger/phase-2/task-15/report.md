# Task 15 — Invitations: implementer's report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written 2026-09-04 on `feat/phase-2-task-15-invitations`, branch base `2aa2f4e`.

Commands below were run as `out=$(pnpm <cmd> 2>&1); code=$?` so the exit code is the command's and
not a pipeline stage's.

---

## 1. The blocker: `POST /api/v1/invitations/accept` is not built

Three of the brief's four endpoints are built. The fourth is not, and the reason is a measurement.

**What was measured.** `Invitation` carries `FORCE ROW LEVEL SECURITY` with
`USING ("organizationId" = current_setting('app.organization_id', true))`
(`packages/db/prisma/migrations/20260820121229_row_level_security/migration.sql:18-22`), and
`sentinel_app` is neither a superuser nor `BYPASSRLS`:

```
docker compose exec -T postgres psql -U sentinel -d sentinel \
  -c "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN (...);"

       rolname       | rolbypassrls | rolsuper
 sentinel            | t            | t
 sentinel_app        | f            | f
 sentinel_org_lookup | t            | f
```

One transaction, `SET LOCAL ROLE sentinel_app`, one seeded `Invitation` with a known `tokenHash`:

```
 app, no app.organization_id set  | 0
 app, correct org set             | 1
 app, wrong org set               | 0
```

D1 says the accept route is authenticated and tenant-less, which is correct — the acceptor is a
member of nothing, so `TenantContextGuard` resolves no organisation and `withTenantTransaction` has
no id to set. **The handler therefore cannot read the invitation its own token names, and neither
can it create the `Membership`, which carries the same policy.**

`withTenantTransaction` (`packages/db/src/tenant-transaction.ts`) has no unscoped mode; there is no
non-RLS table holding a tokenHash-to-organizationId mapping; and the only cross-organisation query
in this product goes through `user_organizations()`, a `SECURITY DEFINER` function created by a
migration (ADR-0021).

**Two ways out, neither of which this task was given the authority to take.**

1. **A second migration** adding a `SECURITY DEFINER` lookup beside `user_organizations()` — an
   `invitation_organization(token_hash text) RETURNS text`, owned by `sentinel_org_lookup`,
   `search_path` pinning `pg_temp` **last** (ruling 106), taking the hash rather than the raw token
   so the raw value never reaches a query the database logs. The brief says explicitly: "a needed
   second migration (the operator reviews migration SQL before it is applied, so you must stop
   rather than write one)". No migration file was written. The SQL sketched above is a proposal in
   this report, not a file in `packages/db/prisma/migrations/`.
2. **Changing the invitation token's format** so the organisation id travels in it, and `accept`
   opens a tenant transaction for the id it parsed, then authorises entirely on the token hash.
   Costed rather than recommended: it makes one endpoint's tenant context derive from client input
   — the thing Task 12's whole pipeline and `assertPathIsActiveTenant`'s docblock exist to prevent
   — and changes the shape of a credential ruling 41 fixed. `opaqueTokenSchema` is
   `z.string().min(1).max(512)` so the contract would not have to change.

**What is in place and unused, so option 1 is a small change on top of this branch:**
`acceptInvitationRequestSchema`, `acceptInvitationResponseSchema`, `INVITATION_ACCEPTED` in
`AUDIT_ACTIONS`, and the `LIVE_INVITATION` predicate in `invitation.service.ts`.

**What is therefore not tested**, from the brief's list of tests that matter:

- a different signed-in user cannot consume someone else's invitation (D11);
- two concurrent accepts of one token yield exactly one `Membership` (D8);
- invite, accept, remove, invite, accept, end to end;
- a revoked invitation cannot be accepted;
- an expired invitation is refused on acceptance (the re-invite-after-expiry half **is** tested).

D9 (ruling 122) is unanswered as a consequence — see section 6.

---

## 2. The other blocker, resolved rather than handed up: the `invitations` rate-limit class refused every request

The brief's route table puts rate-limit class `invitations` on the create route. Applying it as-is
makes that route answer **429 to every request**, and that is not an inference — it is already an
assertion in this repository, shipped since Phase 1:

`apps/api/src/common/guards/rate-limit.integration.spec.ts:290-296` drives
`@RateLimit('invitations')` on a fixture route and expects 429, with the comment "`invitations` is
keyed only per organisation, and there is no tenant context until Phase 2. Skipping the scope would
leave a fail-closed class with no limit whatsoever."

The mechanism: `invitations` declares `perOrganization` and nothing else with `failMode: 'closed'`
(`rate-limit.config.ts:318`); `resolveIdentifier` reads `request.organizationId`
(`rate-limit.guard.ts:163`); **nothing wrote that field** — a grep for assignments to it across
`apps/api/src` excluding specs returned only two `session.repository.ts` lines about a different
field. `RateLimitGuard` was registered first, ahead of `AuthenticationGuard` (`app.module.ts:98`),
so no earlier stage could have written it either.

**Decision I took, which the brief did not take for me: split the limiter into two phases.**
`RATE_LIMIT_SCOPE_PHASES` in `rate-limit.config.ts` partitions the scopes — `perIp` and
`perPrincipal` at the edge pass, `perOrganization` at the tenant pass. `TenantRateLimitGuard` is a
subclass registered after `AuthorizationGuard`; `TenantContextGuard` writes
`request.organizationId` from the resolved context.

Reasoning, and the alternatives rejected:

- **Shipping `generalSession` instead** would leave `abuse-prevention.md` section 1's 50/day row
  enforced by nothing, silently — a fail-open class whose only scope resolves nothing produces no
  log line at the default level (ruling 55). The plan names the class explicitly.
- **Enforcing the limit inside `InvitationService.create`** with `consumeSlidingWindow` directly was
  the smaller change and was rejected: it puts a second model of rate limiting beside the first,
  which is the shape this project's rulings repeatedly strike down, and it would make the route's
  `@RateLimit()` decorator say something false.
- The codebase already nominates this fix: `app.module.ts` said "Splitting the limiter into an early
  per-IP stage and a late per-principal stage is the real fix and is not this task's", and rulings
  55, 59 and 90 each record it as owed with no task claiming it.

**Placement is after `AuthorizationGuard`, not immediately after the tenant resolves.** A
per-organisation window is the tenant's budget; a request the organisation's own rules refuse must
not spend it. Placed earlier, a `GUEST` who cannot invite anybody could exhaust the organisation's
50/day.

**What I did NOT change, deliberately:** `perPrincipal` with `principalSource: 'authenticated'`
stays at the edge, where it still resolves nothing. Rulings 55 and 90 remain open. Moving it would
switch on a 1000/min limit that has never been enforced, across every authenticated route at once,
in a change nobody reviewed for that. Recorded in `RATE_LIMIT_SCOPE_PHASES`'s docblock and in
`app.module.ts`.

**Measured both directions.**

| Mutation | Result |
|---|---|
| `RATE_LIMIT_SCOPE_PHASES.perOrganization` from `tenant` to `edge` | `invitations.integration.spec.ts` **8 tests red**, every create-route test answering 429 — the pre-split behaviour, reproduced |
| the phase filter deleted from the guard loop | `rate-limit.guard.spec.ts` **3 red** (edge pass refuses `invitations`; `perIp` charged twice; tenant pass issues a command it should not) |
| an early `return true` for a phase with no declared scope | **survived — 29/29 green.** It was redundant: `declared` already counts this phase's scopes only. Removed rather than kept with a comment claiming it was load-bearing (ruling 103's shape). Recorded in the guard and in the spec. |

---

## 3. What was built

### New files

```
apps/api/src/modules/invitations/invitations.tokens.ts
apps/api/src/modules/invitations/invitation.mailer.ts
apps/api/src/modules/invitations/invitation.service.ts
apps/api/src/modules/invitations/invitations.controller.ts
apps/api/src/modules/invitations/invitations.module.ts
apps/api/src/modules/invitations/invitations.controller.spec.ts       (27 tests)
apps/api/src/modules/invitations/invitations.integration.spec.ts      (20 tests)
```

### Modified

```
apps/api/src/app.module.ts                       InvitationsModule; TenantRateLimitGuard
apps/api/src/app.module.spec.ts                  ten guards, two limiter passes
common/guards/rate-limit.config.ts               RATE_LIMIT_SCOPE_PHASES
common/guards/rate-limit.guard.ts                phase filter; TenantRateLimitGuard
common/guards/rate-limit.guard.spec.ts           6 new tests for the split
common/guards/tenant-context.ts                  writes request.organizationId
common/guards/authentication.guard.ts            the prohibition's justification corrected
common/guards/email-verified.guard.spec.ts       7 controllers; invitations named
modules/auth/require-mfa.spec.ts                 7 controllers; invitations named
common/authorization-matrix.integration.spec.ts  4 registries extended
modules/audit/audit.actions.ts                   3 actions, 1 resource type, counts recomputed
testing/auth-harness.ts                          'invitations' in AUTH_RATE_LIMIT_CLASSES
apps/api/openapi.json                            regenerated
packages/db/src/datamodel.ts                     DatamodelModel.compoundUniques
packages/db/src/tenant-client.integration.spec.ts  broken test replaced by a sentinel
packages/db/src/tenant-scope.spec.ts             the nested-where property, moved down a layer
.claude/security/audit.md                        one mechanical taxonomy edit — see section 7
```

No migration was written. `packages/db/prisma/schema.prisma` and
`migrations/20260903160000_invitation_partial_unique/` are the brief's, not mine — they arrive with
the branch base `2aa2f4e`.

### Routes

| Route | Access | Verified email | Rate limit |
|---|---|---|---|
| `POST /api/v1/organizations/:id/invitations` | `organization.manage_members` | yes | `invitations` |
| `GET /api/v1/organizations/:id/invitations` | `organization.manage_members` | no | `generalSession` |
| `DELETE /api/v1/organizations/:id/invitations/:invitationId` | `organization.manage_members` | no | `generalSession` |

---

## 4. Decisions I took that the brief did not take for me

Beyond sections 1 and 2.

1. **`InvitationMailerAdapter` in this module, not a tenth method on `AuthMailer`.** `AuthMailer` is
   deliberately not exported from `AuthModule` (`auth.module.ts:228`, reasoning at lines 203-227).
   Adding a method there and exporting the class to reach it would have traded a recorded isolation
   decision for one import. The adapter renders the shared `EMAIL_TEMPLATES.invitation`, so there is
   no second template; `INVITATION_MAILER` narrows it further to a one-function port.
2. **`assertActorMayGrant` is imported, not extracted (D5's fork).** Measured before moving
   anything: `npx madge --circular --extensions ts` on `invitation.service.ts` reported "Processed
   46 files. No circular dependency found!". `membership.service.ts` imports from `organizations/`,
   `audit/`, `auth/` and its own module and never from `invitations/`.
3. **All three routes take `organization.manage_members`, with no `manage_roles` split.** An
   invitation offers a role, and what stops an `ADMIN` offering `OWNER` is D5's set comparison inside
   the handler, which is more accurate than a second permission would be. Recorded in
   `invitations.controller.spec.ts`.
4. **`GET` lists every invitation, not only the live ones.** `invitationResponseSchema` publishes
   `acceptedAt` and `revokedAt` as nullable columns, which is only meaningful if consumed rows can
   appear; a status filter is additive to `listInvitationsQuerySchema` later, while removing rows
   from a shipped list is breaking. A client rendering pending invitations filters on
   `acceptedAt === null && revokedAt === null` and a future `expiresAt`.
5. **Already-a-live-member is 409 `DUPLICATE_RESOURCE`**, per `api/conventions.md` section 2's row
   "409 | Conflict: duplicate, or version mismatch" (line 49) and `api/errors.md`'s Validation list
   (line 93). 422 is for a failed transition; this is a duplicate.
6. **D11's status code, cited rather than invented:** `TokenInvalidError` — 422 `TOKEN_INVALID`.
   `api/errors.md:93` lists `TOKEN_INVALID`; `api/conventions.md` section 2 line 51 gives 422 to
   "Valid shape, failed a domain rule"; `token-invalid.error.ts`'s docblock already names
   "invitation acceptance (Task 15)" as a remaining caller and states that one code covers unknown,
   expired, consumed and superseded so the endpoint cannot become an oracle. **Not exercised**,
   because section 1's blocker means the endpoint does not exist.
7. **An expired invitation is a 404 on revoke, not a 204.** There is nothing to revoke, and a 204
   would tell the caller they had changed something they had not.
8. **`invitations` added to `AUTH_RATE_LIMIT_CLASSES`** in the test harness, so `clearRateLimits`
   can clear a day-long window between runs on a developer's compose Redis.

---

## 5. The broken tenant-client test, and what replaced it

**The measurement.** At branch base, `pnpm typecheck` **EXIT=2**:

```
@sentinel/db:typecheck: src/tenant-client.integration.spec.ts(107,9): error TS2561:
  Object literal may only specify known properties, but 'organizationId_email' does not
  exist in type 'InvitationWhereUniqueInput'. Did you mean to write 'organizationId'?
@sentinel/db:typecheck: src/tenant-client.integration.spec.ts(115,9): error TS2561: [same]
```

**The brief's claim, verified rather than trusted.** A grep for `@@unique` in
`packages/db/prisma/schema.prisma` returns four declarations: line 313 (`MfaFactor`, `userId` and
`type`), lines 399 and 400 (`IdentityProviderLink`); the hits at 488, 532, 561 and 585 are comment
text. `TENANT_OWNED_MODELS` is `['Membership', 'Invitation', 'AuditEvent']`
(`packages/db/src/tenant-resources.ts:12`). **None of the three carries a compound `@@unique`.** The
test has no subject left and there is no third table to move it to.

**What I did.**

1. `DatamodelModel` gains `compoundUniques`, read from the DMMF's `uniqueIndexes` and filtered to
   multi-column entries (`packages/db/src/datamodel.ts`).
2. The deleted test is replaced **in place** by a sentinel that fails on the day a tenant-owned model
   gains a compound `@@unique` again, with a message telling the reader to restore the deleted test
   against it (ruling 101: a sentinel that fails when the feature arrives must name what replaces
   it). It asserts both directions — the tenant-owned set is empty, **and** the models that do carry
   one are exactly `IdentityProviderLink` and `MfaFactor`, so the empty set cannot pass because the
   filter broke.
3. The property itself — the extension runs the original `findUnique` unmodified rather than
   rewriting `where` — moved down a layer to `packages/db/src/tenant-scope.spec.ts`, where
   `decideScope` is typed over `args: unknown` and the nested compound shape can be stated directly.
   Asserted with `toEqual` on the whole plan **and** `toBe` on the `where`, because deep equality
   alone is satisfied by a defensive copy.

**What is lost, stated plainly.** The nested-`where` shape is no longer exercised against a real
Prisma client and a real database. `decideScope` is where the decision is made and the unit test is a
real guard, but it cannot show that Prisma then issues the query the plan describes. Both the loss
and the reasoning are written into the comment that replaced the test.

**Measured that the replacement bites.** Mutating `decideScope`'s findUnique arm to merge
`organizationId` into `where`: `tenant-scope.spec.ts` **6 failed / 21 passed**, the new test among
them. Restored: 27 passed.

Full-tree result after: `pnpm typecheck` **EXIT=0**.

---

## 6. D9 (ruling 122) — unanswered, and why

D9 asks whether acceptance can leave a `Membership` standing that should not: a credential issued
against a fact that can change, re-read after issuing.

**I cannot answer it with a measurement, because there is no acceptance path to measure.** The
brief's instruction was to report the reasoning with a measurement either way, and "the endpoint
checks first" is exactly the argument rulings 82 and 122 struck down — so the honest report is that
this is **owed by whoever builds `accept`**, not that it was analysed. What the design would have to
close, stated so the next implementer does not re-derive it:

- the invitation's liveness is closed **inside** the transaction by D8's conditional consume — an
  `updateMany` asserting the count is exactly one over a live, unexpired row. That half is the same
  shape `TokenService.consume` already uses and needs no re-read;
- the organisation's state is **not**. A concurrent `ORGANIZATION_SUSPENDED` (Phase 11) or a
  concurrent last-owner removal decided from a snapshot taken before the membership insert is the
  window ruling 122 is about, and `lockOrganization` in `membership.service.ts` is what acceptance
  must take — `permissions.md` invariant 1's own text says "Every future writer of `Membership` must
  take the same lock — Task 15's invitation acceptance is the next one".

`lockOrganization` is **not exported** from `membership.service.ts` today (declared at line 156 with
no `export`), so building acceptance means exporting it or extracting it.

---

## 7. `.claude/` documents whose text this change makes false

Per Rule 1 I have not written replacement prose. One mechanical edit was unavoidable and is declared
first.

**Edited (one line, mechanical, because a shipped parity spec fails otherwise).**
`.claude/security/audit.md:198` read, with backticks around each name:

> MEMBER_INVITED, INVITATION_ACCEPTED/REVOKED, MEMBER_REMOVED, ROLE_CHANGED,

`audit.service.spec.ts`'s "names every action in security/audit.md section 4" test asserts the
document contains each action name wrapped in backticks — the slash-combined form contains neither
backticked name, so adding the two actions to `AUDIT_ACTIONS` turned it red. The slash form is now
two separately backticked names. No sentence was added, removed or rewritten. The paragraph beneath,
which explains which task gave `MEMBER_REMOVED` and `ROLE_CHANGED` producers, says nothing about the
three invitation actions and is the orchestrator's to extend.

**Believed false, not edited.**

1. `.claude/architecture/backend.md:141` —

   > "`app.module.spec.ts` asserts it, and as of Task 12 there are **nine**: rate limit,
   > authenticate, tenant resolve, CSRF, cross-site refusal, email verified, MFA enrolment,
   > authorize, entitlement."

   There are ten. The tenth is `TenantRateLimitGuard`, between authorize and entitlement.
   `pnpm test` pins it: `app.module.spec.ts` asserts the exact array and a length of 10.

2. `.claude/architecture/backend.md:168-176` —

   > "Splitting the limiter into an early per-IP stage and a late per-principal one is the fix, and
   > it is not built."

   The split is built. What is not built is the per-principal half of it: `perPrincipal` stays at the
   edge deliberately (section 2). Everything the paragraph says about `generalSession` remains true.

3. `.claude/architecture/backend.md:99` —

   > "**It governs seven shipped routes as of Task 14**"

   Ten. `EXPECTED_GUARDED_ROUTES` in `authorization-matrix.integration.spec.ts` now holds ten entries
   and the assertion is green.

4. `.claude/security/authorization.md:301` —

   > "**The 403 and cross-tenant-404 arms run over seven shipped routes as of Task 14** — the three
   > on `/api/v1/organizations/{id}` (Task 13, the first endpoints in this product to declare a
   > permission), the three on `/api/v1/organizations/{id}/members`, and `GET /api/v1/roles`."

   Ten, with three on `/api/v1/organizations/{id}/invitations`.

5. `.claude/security/authorization.md:109` —

   > "**The no-minting rule has two enforcement points as of Phase 2 Task 14, and neither is custom
   > roles.**"

   Three. The third is `InvitationService.create`, which asks the same question of the role being
   offered.

6. `.claude/security/authentication.md:357-358` —

   > "The invitation row is Task 15's and remains Designed only."

   The orchestrator owns the wording: issuing, hashing at rest, the 7-day TTL, revocation and
   invalidation-by-a-newer-token are built and tested; **acceptance is not built at all** (section
   1). The table row at line 366 — "Bound to the invited address; revocable; accepting requires
   authentication as that address" — describes something whose last clause has no code.

7. `.claude/security/abuse-prevention.md:151-155` —

   > "**An unresolvable scope is not a free pass.** `invitations` and `scanCreate` are keyed only per
   > organisation, and there is no tenant context before Phase 2. If the guard simply skipped a scope
   > it could not resolve, those fail-closed classes would carry no limit at all."

   The first sentence still holds and the mechanism has changed: `invitations` is now resolvable, in
   the tenant phase. The clause "there is no tenant context before Phase 2" is now history rather
   than description, and the paragraph does not mention that the limiter runs twice.

8. `.claude/product/permissions.md:112` —

   > "**Every future writer of `Membership` must take the same lock** — Task 15's invitation
   > acceptance is the next one"

   Still true as a rule and still unmet: no invitation acceptance exists (sections 1 and 6). Flagged
   because a reader could take "Task 15's" as a claim that it landed.

9. `.claude/product/permissions.md:126-127` —

   > "Task 14's role change and Task 15's invitation acceptance are both still unwritten"

   Half of it is now false in the other direction — Task 14's role change shipped — and the
   invitation half is still true. The sentence predates Task 14 and this task did not make it worse;
   recorded because it sits in the paragraph a reader of Task 15 will land on.

**Not in `.claude/`, but false and worth a line.** `apps/api/src/modules/auth/emails/registry.ts:36`
says "There are NINE members." The record holds **ten**: emailVerification, passwordReset,
invitation, passwordChanged, mfaEnabled, mfaDisabled, mfaRecoveryCodesRegenerated, newDeviceSignIn,
registrationAttempt, failedLoginBurst — counted, not remembered. `mfaRecoveryCodesRegenerated` was
added in Task 11's fix round without the count moving. Not corrected here: it is not my change that
made it false, and ruling 108's instruction is to compute rather than adjust. Handed up.

---

## 8. Verification

Every command run at `f42729f` on the finished tree, exit code captured outside a pipe.

| Command | Exit | Notes |
|---|---|---|
| `pnpm format:check` | **0** | |
| `pnpm lint` | **0** | |
| `pnpm typecheck` | **0** | was **2** at branch base — section 5 |
| `pnpm test` | **0** | 100 files / 1709 tests |
| `pnpm check:specs` | **0** | 128 spec files, each claimed by exactly one project |
| `pnpm test:integration` (run 1) | **0** | 28 files / 505 tests |
| `pnpm test:integration` (run 2) | **0** | 28 files / 505 tests |
| `pnpm build` | **0** | |
| `pnpm check:openapi` | **0** | byte-identical at **26 paths** |
| `pnpm check:registry` | **0** | 15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm check:secrets` | **0** | 453 tracked files |

Two integration runs end to end, per ruling 119. Both green.

**`check:openapi` route count: 24 before, 26 after.** `main` at `77d74e4` and this branch's base both
read 24. The two new paths are `/api/v1/organizations/{id}/invitations` and
`/api/v1/organizations/{id}/invitations/{invitationId}` — three operations across two paths.
`pnpm check:openapi` failed with EXIT=1 before regeneration, as the brief predicted, and the diff it
printed named exactly those two paths.

`docker compose ps` reported mailpit, minio, postgres and redis all running and healthy throughout.

---

## 9. Mutation testing — what each guard was measured against

Every row is a mutation applied to the working tree, the named suite re-run, then the mutation
reverted and the suite re-run green.

| Mutation | Suite | Result |
|---|---|---|
| `deletedAt: null` removed from `assertNotAlreadyAMember` | invitations integration | **1 red** — the ruling 99/100 test |
| the supersede `updateMany` disabled in `create` | invitations integration | **3 red** — supersede, expired-supersede, and the two-at-once arm |
| `perOrganization` moved back to the edge phase | invitations integration | **8 red** — every create-route test at 429 |
| `lockInvitationSlot` deleted | invitations integration, **3 full runs** | **EXIT=0, EXIT=0, EXIT=1** with the `Promise.all` arm alone; **1 red on every one of 3 runs** once the advisory-lock detector was added |
| the phase filter deleted from the guard loop | `rate-limit.guard.spec.ts` | **3 red** |
| an early `return true` for a scope-less phase | `rate-limit.guard.spec.ts` | **survived, 29/29 green** — removed as redundant |
| `decideScope` merging `organizationId` into a findUnique `where` | `tenant-scope.spec.ts` | **6 red**, including the new nested-`where` test |

**The advisory-lock finding is the one worth carrying.** The first concurrency test for D4 was a
`Promise.all` of two creates, asserting two 201s and one live row. Deleting the lock left it green on
**two runs of three** — ruling 119's defect exactly, on a branch whose brief cites ruling 119. What
replaced it is a deterministic detector: a second `sentinel_app` connection takes a **session-level**
`pg_advisory_lock` on `hashtext('inv:<org>:<email>')`, the create request is fired, and the test
asserts it has **not** settled after 1000 ms. Deleting the lock fails it on 3 runs of 3. An advisory
blocker rather than a row lock, because of ruling 121: the tenant-scoping extension forces
`organizationId` into every `updateMany` payload, so a `FOR UPDATE` blocker on `Organization`
conflicts whether or not the handler locks anything. A second arm asserts the lock is **not** taken
for a different address in the same organisation, so the detector cannot pass because the handler
locks something coarse.

`pg_advisory_lock` returns `void` and `$queryRaw` cannot deserialise it — the same trap
`TokenService.issueInTransaction` documents, and it raises *after* the lock is taken. Both call sites
in the spec wrap it in a subquery. Found by the detector's first run failing with "Failed to
deserialize column of type 'void'".

---

## 10. Everything I could not finish

1. **`POST /api/v1/invitations/accept`.** Section 1. Blocked on a decision the operator owns.
2. **Every accept-dependent test the brief names.** Section 1.
3. **D9 / ruling 122.** Section 6. Unanswerable without an acceptance path; not analysed, and the
   paragraph in section 6 is a design note, not a measurement.
4. **The `invitations` window is never actually spent in a test.** The integration spec asserts the
   limit engaged — `RateLimit-Limit: 50`, `RateLimit-Remaining: 49` then 48 on the same organisation
   and 49 on another — rather than driving 51 requests to a 429. What is proved is that the class
   resolves, charges the right key, and is the organisation's window. What is not proved end to end
   is the refusal at 51.
5. **No `invitation.service.spec.ts`.** Every branch in that service needs a database or a
   transaction handle; the two pure functions are covered by the integration lane. Recorded as a
   choice rather than an omission — a unit spec built on a fake Prisma here would be ruling 66's
   shape.
6. **`accept`'s share of the audit vocabulary is declared and unwritten.** `INVITATION_ACCEPTED` is
   in `AUDIT_ACTIONS` with no producer. That is the one place this branch does what
   `audit.actions.ts`'s own rule forbids — "Only names something in this codebase writes" — and it is
   deliberate: removing it and re-adding it with the accept endpoint is the alternative, and the
   constant's docblock would then have to argue an absence that has a decided design. Flagged for the
   orchestrator to rule on either way.
7. **`registry.ts`'s "NINE members".** Section 7, last block. Not corrected.
8. **Nothing was pushed.** No PR, no merge — ruling 114.

---

## Fix round

**Written by the orchestrator, not by the implementer, and that is a departure worth naming.**
The fix-round implementer's session was killed by a transient HTTP 529 partway through, after it
had committed four commits and while it was about to commit a fifth. Everything below is
reconstructed from `git show` over `23744af..7b33fac` and from verification the orchestrator ran
itself on the finished tree. Nothing here is taken from the implementer's own summary, because it
never wrote one.

### What landed, by commit

| Commit | What |
|---|---|
| `96490ac` | `POST /api/v1/invitations/accept` on its own tenant-less controller; `invitation-organization.store.ts` as the port over ADR-0022's definer function; `lockOrganization` exported from `membership.service.ts` rather than duplicated; F-1 and F-9 and F-3 |
| `189f69f` | C-2's two recomputed counts, the eighth controller sentinel, accept's decorator assertions |
| `1529fe4` | The acceptance path's tests, its two deterministic races, and D9 measured |
| `7b33fac` | `openapi.json` regenerated, 26 paths → 27 |
| `0bfd550` | ADR-0022's function asserted on every run — written by the implementer, left uncommitted when its session died, verified by the orchestrator before committing |

### D9 / ruling 122 — the answer, which is three answers

The implementer's analysis is in `invitation.service.ts`'s `accept` docblock and it does not claim
a clean result. Three facts a `Membership` is issued against:

1. **The invitation's liveness — CLOSED**, and not by the pre-check. `accept`'s conditional
   `updateMany` and `revoke`'s write the same row under the same predicate, so Postgres serialises
   them at row level and whichever commits second matches nothing. Pinned by a test using a
   session-level advisory-lock blocker rather than a `Promise.all`, per ruling 119.
2. **The organisation's state — NOT closed, and cannot be.** Nothing in this API writes
   `Organization.status`, so a suspension can land one microsecond after any re-read. What makes
   it survivable is structural: a `Membership` is not a bearer credential. There is no permission
   cache (ruling 94), `TenantContextGuard` re-resolves membership and organisation status on every
   request naming an organisation, and acceptance mints no session. This is the difference from
   ruling 82's `Session`, which carries captured privilege for up to 30 days.
3. **The inviter's authority — OPEN, and recorded rather than claimed closed.** See below.

### The open window, stated plainly because it is a security gap

**An invitation offering `OWNER` survives its issuer being removed, and accepting it still mints an
`OWNER`.** D5's no-minting check runs in `create` and nowhere else. Measured end to end through
Task 14's real `DELETE .../members/:membershipId`: the removed owner's invitation is still live and
the acceptor receives 201 with `roleKey: OWNER`.

This is a re-escalation path for somebody removed precisely to take that authority away, through an
address they control. It is ruling 124's shape exactly — an authority rule enforced on one verb and
not on the events that should invalidate its output.

The remedy is on the other side of the transaction, in `MembershipService.remove` and `updateRole`,
where the invitations a departing member issued and could no longer issue would be revoked in the
same transaction as the removal. That is a change to Task 14's writes, and it is **handed up, not
taken here**. Re-running `assertActorMayGrant` at accept time instead was considered and rejected:
it would refuse every invitation from a colleague who has since legitimately left, a lock-out with
no recovery path for the invitee.

It is pinned by `D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's authority`,
written to fail if the behaviour changes silently and named so nobody reads it as approval.

### One defect found by the orchestrator in the fix round's own work

`invitation.service.ts:653` cited that test as `records the OPEN D9 window` — a paraphrase, not the
test's name — so a grep for the citation found nothing and the docblock read as a reference to a
test that did not exist. The test is real and thorough; the citation was not. Corrected to quote
the name exactly, with a note saying why.
