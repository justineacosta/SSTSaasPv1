# Task 15 (Invitations) — Adversarial Review

**Status: IN PROGRESS.** Built incrementally; each finding is written the moment it is
established. If this document ends abruptly, everything above the cut is verified work.

Reviewer: adversarial reviewer agent (did not write the code under review).
Branch: `feat/phase-2-task-15-invitations`, commits `2aa2f4e..HEAD`, base `main` at `77d74e4`.

Every finding is labelled **MEASURED** (I ran a command / read the cited line and reproduce
the failure) or **INFERRED** (reasoned from code without executing it).

---

## Pass 1 — Citation

### Counts recomputed from source

| Claim | Where asserted | Computed | Verdict |
|---|---|---|---|
| `AUDIT_ACTIONS` holds **eight** names | `apps/api/src/modules/audit/audit.actions.ts:232-238` (docblock census) | 8 | **correct** |
| `AUDIT_RESOURCE_TYPES` holds **three** | same docblock | 3 | **correct** |
| `EMAIL_TEMPLATES` has "**NINE** members" | `apps/api/src/modules/auth/emails/registry.ts:37` | **10** | **WRONG** — C-1 |
| `EXPECTED_GUARDED_ROUTES` holds **ten** | `authorization-matrix.integration.spec.ts:634-660` | 10 | **correct** |
| "**Seven** routes now declare one" | `authorization-matrix.integration.spec.ts:45` | 10 | **WRONG** — C-2 |
| `invitations.controller.spec.ts` — 27 tests | report §3 | 27 | **correct** |
| `invitations.integration.spec.ts` — 20 tests | report §3 | 20 `it(` blocks | **correct** |
| `check:specs` — 128 spec files | report §8 | 128 | **correct** |
| `openapi.json` — 26 paths | report §8 | 26 | **correct** |
| `schema.prisma` `@@unique` — "four declarations" | report §5 | **3** | **WRONG** — C-3 |

Commands:

```
$ node -e "...count EMAIL_TEMPLATES members..."
EMAIL_TEMPLATES members = 10
emailVerification, passwordReset, invitation, passwordChanged, mfaEnabled,
mfaDisabled, mfaRecoveryCodesRegenerated, newDeviceSignIn, registrationAttempt,
failedLoginBurst
TOKEN_LINK = 3  NOTICE = 7

$ node -e "...count AUDIT_ACTIONS / AUDIT_RESOURCE_TYPES..."
AUDIT_ACTIONS = 8
   ORGANIZATION_CREATED, ORGANIZATION_UPDATED, ORGANIZATION_SWITCHED, ROLE_CHANGED,
   MEMBER_REMOVED, MEMBER_INVITED, INVITATION_REVOKED, INVITATION_ACCEPTED
AUDIT_RESOURCE_TYPES = 3
   Organization, Membership, Invitation

$ node -e "...count EXPECTED_GUARDED_ROUTES entries..."
EXPECTED_GUARDED_ROUTES entries = 10

$ npx vitest run --project unit apps/api/src/modules/invitations/invitations.controller.spec.ts
EXIT=0 ... 27 passed (27)

$ pnpm check:specs
EXIT=0  check:specs OK — 128 spec files

$ grep -c "@@unique" packages/db/prisma/schema.prisma        -> 10
$ grep -c "^\s*@@unique" packages/db/prisma/schema.prisma    -> 3
```

---

### C-1 — `registry.ts` docblock says NINE members; there are TEN. **Low. MEASURED.**

`apps/api/src/modules/auth/emails/registry.ts:37` — "There are NINE members."
`EMAIL_TEMPLATES` (lines 53-64) holds ten. The orchestrator's belief is **confirmed**, and the
implementer's report §7 last block is **accurate** including its enumeration and its diagnosis
(`mfaRecoveryCodesRegenerated` was added without the count moving).

Two further errors in the same docblock that neither the implementer nor the orchestrator named:

- Line 24: "Six near-identical assertion blocks … instead of six times over six templates."
  Pre-existing (the file was created as `7918468 feat(auth): six email templates behind a
  registry` — whose own subject line miscounts: that commit's `EMAIL_TEMPLATES` already held
  **seven**, verified by `git show 7918468:…/registry.ts`). Not this task's defect, but it is the
  same sentence family and a corrector who fixes only "NINE" leaves it.
- The ordinal narrative ("Seven were built in Task 5 … The eighth … The ninth") is arithmetically
  consistent with nine and silently drops the tenth. Fixing the numeral alone leaves the paragraph
  describing nine templates while the record holds ten.

Not introduced by Task 15. Correctly handed up rather than silently adjusted (ruling 108 followed).

### C-2 — a count that says it is "counted from the constant below" was not recounted when this task extended that constant. **Medium. MEASURED.**

`apps/api/src/common/authorization-matrix.integration.spec.ts:45-48`:

> "**Seven** routes now declare one, counted from `EXPECTED_GUARDED_ROUTES` below rather than
> remembered: three on `/organizations/:id` (Task 13), three on `/organizations/:id/members` and
> `GET /roles` (Task 14)."

This change added three entries to `EXPECTED_GUARDED_ROUTES` (lines 657-659) taking it to **ten**,
and left the sentence at seven. The sentence's own claim — "counted from … rather than remembered"
— is now false of itself. This is the ruling-108 defect *inside the file this task edited*, not in
a `.claude/` document, and so it is not covered by report §7's list of documents believed false:
§7 items 3 and 4 name `backend.md:99` and `authorization.md:301` for exactly this count and miss
the in-repo copy.

Second, dependent miscount in the same docblock, line 57:

> "The other five routes produce real 403s."

Arm 2 is inapplicable only for the two `organization.read` routes (`GET /organizations/:id`,
`GET /roles`). 10 − 2 = **eight** routes produce real 403s, not five. Both numbers moved; neither
was updated.

Severity Medium rather than Low because this docblock is the one a reader consults to learn how
much the authorization matrix actually covers, and it now understates coverage by three routes
while asserting it was computed.

### C-3 — report §5's `@@unique` census does not reproduce. **Low. MEASURED.**

Report §5 states:

> "A grep for `@@unique` in `packages/db/prisma/schema.prisma` returns four declarations: line 313
> (`MfaFactor`, `userId` and `type`), lines 399 and 400 (`IdentityProviderLink`); the hits at 488,
> 532, 561 and 585 are comment text."

Measured at `f42729f` (the commit the report says it ran at) and at `HEAD` — identical, the file
did not change after `2aa2f4e`:

```
$ git show f42729f:packages/db/prisma/schema.prisma | grep -n "@@unique"
313, 369, 399, 400, 488, 517, 532, 533, 561, 585      (10 hits)
$ grep -c "^\s*@@unique" packages/db/prisma/schema.prisma
3
```

Two errors: **three** declarations are enumerated but called "four", and the comment hits are
enumerated as four when there are **seven** (369, 517 and 533 are omitted). Ten hits are accounted
for as seven.

The *conclusion* drawn from the census — "none of `Membership`, `Invitation`, `AuditEvent` carries a
compound `@@unique`" — is **correct** (the three real declarations are on `MfaFactor` and
`IdentityProviderLink`). So this is a false supporting measurement under a true claim, which is
the harder kind to catch and exactly the phase's recurring defect.

---

### C-4 — ADR-0022 and ADR-0023 measurements: reproduced, with one off-by-two citation

**ADR-0022** (`invitation-acceptance-definer-lookup`). Every measurement quoted reproduces.

I re-ran the ADR's own probe table against the live compose Postgres, in a transaction that was
rolled back (`docker compose exec -T postgres psql -U sentinel -d sentinel`, `SET LOCAL ROLE
sentinel_app`, one seeded `Invitation` with `tokenHash = 'REVIEWHASH_abc'`):

```
 A direct read, no org set  | 0
 B definer, no org set      | org_rev_a
 C definer, wrong hash      | NULL
 D direct read, correct org | 1
 E direct read, wrong org   | 0
```

That is the ADR's table exactly, plus row E which it did not need. Role attributes and grants also
reproduce:

```
       rolname       | rolsuper | rolbypassrls | rolcanlogin
 sentinel            | t        | t            | t
 sentinel_app        | f        | f            | t
 sentinel_org_lookup | f        | t            | f

                proname                |        owner        | prosecdef |          proconfig
 user_organizations                    | sentinel_org_lookup | t         | {"search_path=public, pg_temp"}
 invitation_organization_by_token_hash | sentinel_org_lookup | t         | {"search_path=public, pg_temp"}

 grantee: sentinel_org_lookup -> SELECT on Invitation, Membership, Organization   (three tables)
 proacl:  {sentinel_org_lookup=X/…, sentinel_app=X/…}                             (PUBLIC has none)
 has_database_privilege('sentinel_app','TEMPORARY')  = f
 has_database_privilege('public','TEMPORARY')        = f
```

So the ADR's Consequences ("three tables instead of two", "`sentinel_app` gains EXECUTE on one more
function and is otherwise unchanged") are **true as measured**.

**One citation is wrong.** ADR-0022's Context cites the `Invitation` policy at
`…/20260820121229_row_level_security/migration.sql:18-20`. Lines 18-20 are `ALTER TABLE … ENABLE`,
`ALTER TABLE … FORCE`, `CREATE POLICY "tenant_isolation" ON "Invitation"`. The predicate the ADR
quotes on the same line — `USING ("organizationId" = current_setting('app.organization_id', true))`
— is at line **21**, and the `WITH CHECK` half at 22. The implementer's report cited **18-22**,
which is right; the ADR narrowed it and cut off the quoted text. **Low, MEASURED.**

**ADR-0023** (`rate-limiter-runs-in-two-phases`). Measurements reproduce.

- `rate-limit.integration.spec.ts:290-296` is exactly the cited test — verified with
  `grep -n "refuses when a fail-closed class has no resolvable scope"` → line 290, closing `});` at
  296. The ADR's line range is correct (report §2 cites the same range).
- The `RATE_LIMIT_SCOPE_PHASES` table quoted in the ADR matches
  `rate-limit.config.ts:378-382` exactly.
- "The guard pipeline is ten global guards" — `app.module.spec.ts` asserts `toHaveLength(10)` and
  the exact ordered array with `TenantRateLimitGuard` between `AuthorizationGuard` and
  `EntitlementGuard`; three relational assertions are present as the ADR claims.
- "The edge pass is unchanged for every existing route" — verified by enumerating every
  `@RateLimit(...)` in `apps/api/src` outside specs (30 hits, 24 of them decorators). Only
  `invitations.controller.ts:136` names a class with a `perOrganization` scope. Every other shipped
  route uses `generalSession`, `login`, `registration`, `passwordReset*`, `mfa*`,
  `emailVerification*` — all `perIp`/`perPrincipal`, i.e. edge-only. **The claim holds.**


---

## Pass 2 — Code findings

### F-1 — `revoke`'s docblock and the implementer's report both claim an expired invitation answers 404. The code answers 204 and writes an audit row. **High. MEASURED (code); behaviour INFERRED from a literal predicate.**

`apps/api/src/modules/invitations/invitation.service.ts` (the `revoke` docblock):

> "**An invitation that is already accepted, already revoked, expired, or belongs to another
> organisation all answer the same 404.** … An expired invitation answering 404 rather than a
> successful revocation is deliberate: there is nothing to revoke, and a 204 would tell the caller
> they had changed something they had not."

Report §4 item 7 repeats it as a decision taken:

> "**An expired invitation is a 404 on revoke, not a 204.** There is nothing to revoke, and a 204
> would tell the caller they had changed something they had not."

The predicate that decides it is `LIVE_INVITATION`:

```ts
const LIVE_INVITATION = { acceptedAt: null, revokedAt: null } as const;
```

`revoke` uses it and nothing else, in both statements:

```ts
where: { id: invitationId, organizationId: ctx.organizationId, ...LIVE_INVITATION },
```

**There is no `expiresAt` term anywhere in `revoke`.** An expired-but-unconsumed invitation has
`acceptedAt IS NULL` and `revokedAt IS NULL` — the same file says so twice, in `create`'s
supersede comment ("an expired-but-unconsumed row still holds the slot") and in `LIVE_INVITATION`'s
own docblock ("An expired row is still 'live' by this definition and still holds the slot"). So
`findFirst` returns it, `updateMany` matches it and reports `count: 1`, an `INVITATION_REVOKED`
audit event is written, and the endpoint answers **204**.

The behaviour is arguably the better one. The defect is that two pieces of prose — one of them a
docblock a future reader will trust over the code — assert the opposite, and **no test covers it**:

```
$ grep -n "  it(" apps/api/src/modules/invitations/invitations.integration.spec.ts | grep -i revok
850:  it('answers 404 to an invitation that is already revoked, already accepted, or absent', …
919:  it('does not write two audit rows when two revocations race one invitation', …
```

Expired is deliberately not in that list, and the report's §10 ("everything I could not finish")
does not name it as untested either. Either the predicate gains an expiry term and the test gains a
fourth id, or both docblock and report lose the sentence. As it stands the file documents a control
it does not have.

### F-2 — the second limiter pass is skipped by every refusal above it, and `invitations` declares nothing at the edge, so the create route has **no** rate limit for any request that fails a guard. **Medium. INFERRED (from the asserted guard order and the class table).**

Asserted guard order (`apps/api/src/app.module.spec.ts`, green):

```
RateLimitGuard, AuthenticationGuard, TenantContextGuard, CsrfGuard, CrossSiteGuard,
EmailVerifiedGuard, MfaEnrolmentGuard, AuthorizationGuard, TenantRateLimitGuard, EntitlementGuard
```

`invitations` is `{ perOrganization: …, failMode: 'closed' }` and nothing else
(`rate-limit.config.ts:318`), and `RATE_LIMIT_SCOPE_PHASES` puts `perOrganization` in `'tenant'`.
So on `POST /api/v1/organizations/:id/invitations`:

- the **edge** pass filters the scope list to `perIp`/`perPrincipal`, finds neither declared,
  `declared === 0`, and returns true **without issuing a Redis command** — by design, and the
  guard's own comment says so;
- any refusal from CSRF, cross-site, `@RequireVerifiedEmail()`, MFA enrolment, `AuthorizationGuard`,
  or an unresolved tenant throws **before** `TenantRateLimitGuard` runs.

Concretely: a signed-in `GUEST` (or any member without `organization.manage_members`, or anyone
whose email is unverified) can issue **unlimited** POSTs to that route. Each one costs a Redis
session read, a Postgres user read and a full tenant-context resolution, and charges no window
anywhere. Before the split the same request was refused at the edge for zero backend cost.

This is the inverse of the trade ADR-0023's placement argument states ("a `GUEST` who cannot invite
anybody could still exhaust the organisation's daily invitation budget"). The ADR's Consequences
section lists three items and does not include this one; `TenantRateLimitGuard`'s own docblock makes
the same one-sided argument.

Honest bound on severity: rulings 55 and 90 already leave `generalSession`'s `perPrincipal` limit
applied to no request, so **every** authenticated route in this API is currently unlimited and this
one is no worse than its neighbours. That is why this is Medium and not High. What is new is that
the ADR presents the placement as a pure win and the second half of the trade is unrecorded.

### F-3 — `POST /api/v1/invitations/accept`, when built, cannot carry any `perOrganization` class, and nothing records that. **Low. INFERRED.**

D1 makes accept authenticated and tenant-less, so `TenantContextGuard` resolves nothing and
`request.organizationId` stays undefined — it is written only in the `resolution.outcome ===
'resolved'` arm. The tenant pass would then see `declared === 1`, `decisions.length === 0`,
`failMode: 'closed'` → **429 on every request**, which is precisely the pre-split failure ADR-0023
exists to remove. So accept must fall back to `generalSession` — whose only scope is the
`perPrincipal` that rulings 55/90 leave unresolvable. **The endpoint that consumes a credential
from a request body will therefore ship with no rate limit at all.**

The token is 256 bits, so this is not a brute-force exposure; it is an unmetered channel into a
database lookup that also invokes the `SECURITY DEFINER` function. Neither ADR names it and neither
does the `RATE_LIMIT_SCOPE_PHASES` docblock. It is the first thing the accept implementer will hit.

### F-4 — token discipline: clean.

Verified against `security/authentication.md` §6's five properties.

| Property | Where | Verdict |
|---|---|---|
| 256-bit random | `secret-token.ts` — `SECRET_TOKEN_BYTES = 32`, `randomBytes(32).toString('base64url')` | holds |
| hashed at rest | `mintSecretToken` returns `{token, tokenHash: sha256(token)}`; only `minted.tokenHash` reaches `tx.invitation.create` | holds |
| 7-day TTL | `this.tokens.expiresAtFor('INVITATION')` reads `TOKEN_TTL_INVITATION_SECONDS`, default `604_800` (`packages/config/src/env.ts:212`; `env.spec.ts:376` asserts `604_800 // 7d`) | holds |
| email-only delivery | `created.token` is passed only to `this.sendInvitation(...)`, after the commit; `InvitationMailerAdapter.send` puts it in `EMAIL_TEMPLATES.invitation` and in no log line (the failure log names `templateId` and `recipient` only) | holds |
| never echoed by an endpoint | `INVITATION_COLUMNS` has no `tokenHash`; all three statements returning an invitation use it; `toResponse` maps a fixed field list. Integration asserts both halves — "creates an invitation, sends exactly one message, and **returns no token**" and "lists the organisation's invitations newest first, **and never a token**" | holds |
| not in the audit row | `MEMBER_INVITED` metadata is `{email, roleKey, supersededInvitationId}`; `minted.token` is not referenced in that object | holds |

Single-use is **not** verifiable, because consumption is the accept endpoint and it does not exist.

### F-5 — audit events: in-transaction, correct resource type, and `INVITATION_EXPIRED`'s absence is honest.

- `MEMBER_INVITED` is written by `this.audit.record(tx, …)` inside the `withTenantTransaction`
  callback, as is `INVITATION_REVOKED`. `AuditService.record` takes the transaction handle rather
  than opening one, so `CLAUDE.md` rule 10 holds by construction. The revoke test asserts the
  pairing directly ("revokes a pending invitation, with the audit row in the same transaction"),
  and the 404 test asserts **zero** `INVITATION_REVOKED` rows after three refusals.
- `resourceType: 'Invitation'` on both, and `'Invitation'` is in `AUDIT_RESOURCE_TYPES`.
- D4's "the superseded row gets no `INVITATION_REVOKED`" holds: the supersede `updateMany` writes
  no event, and the id travels in `MEMBER_INVITED.metadata.supersededInvitationId`.
- `INVITATION_EXPIRED`'s documented absence is **honest**: `grep -rn "INVITATION_EXPIRED" .claude/`
  returns nothing, so the comment's claim "`security/audit.md` §4 does not list `INVITATION_EXPIRED`
  either, so nothing is owed to that document" reproduces.
- The one real inconsistency is the one the report flags itself (§10 item 6): `INVITATION_ACCEPTED`
  is in `AUDIT_ACTIONS` with **no producer**, which that constant's own governing rule ("Only names
  something in this codebase writes") forbids. Flagged honestly; it remains a live contradiction in
  the file and the orchestrator has not ruled on it.

### F-6 — the tenant-client test resolution: a real guard was traded for a weaker real guard plus a maintenance sentinel. Defensible, and the loss is stated honestly. **No finding above Low.**

What went: `tenant-client.integration.spec.ts`'s "rewrites findUnique by a compound unique key, not
just by id", which drove a real `findUnique` with a nested compound `where` through a real tenant
client against a real Postgres.

What replaced it, and whether each bites:

1. **The moved unit property** in `packages/db/src/tenant-scope.spec.ts` — "passes a NESTED compound
   `where` through byte-for-byte, never merging into it". **It bites. MEASURED.** I mutated
   `decideScope`'s `findUnique` arm to merge the scope column into `where`:

   ```ts
   const mutated = checkedArgs as { where?: Record<string, unknown> };
   return { kind: 'run-and-check',
            args: { ...mutated, where: { ...mutated.where, [keyField]: organizationId } }, … };
   ```

   ```
   $ npx vitest run --project unit packages/db/src/tenant-scope.spec.ts
   Tests  6 failed | 21 passed (27)
     × decideScope > rewrites findUnique to a run-and-check plan instead of a different operation
     × decideScope > passes a NESTED compound `where` through byte-for-byte, never merging into it
     × decideScope > widens a select that omits the scope column, and flags it for stripping
     × decideScope > leaves a select that already asks for the scope column alone
     × decideScope > drops the scope column from an omit that excludes it, and flags it for stripping
     × decideScope > leaves an omit that does not exclude the scope column alone
   ```

   Restored from a backup copy; re-ran: `Tests 27 passed (27)`; `git status --short` clean.
   **This reproduces the report §5 / §9 row exactly** ("6 red, including the new nested-`where`
   test" / "Restored: 27 passed").

2. **The DMMF sentinel** in `tenant-client.integration.spec.ts`. It is not a regression guard for
   the tenant client — it cannot fail for the reason the deleted test could. It is a maintenance
   sentinel that fails on the day a tenant-owned model regains a compound `@@unique`, and its
   message names the test to restore, which is ruling 101's requirement. Its second assertion
   (`anyCompound` must be exactly `['IdentityProviderLink','MfaFactor']`) is what stops the empty
   set passing vacuously through a broken filter — **INFERRED**, read from the code; I did not run
   the integration lane against a mutated `compoundUniques` filter.

Judgement: the answer is honest and the loss is written where a reader will meet it ("What is lost,
stated plainly" in the replacement comment). The residual gap is real and correctly named — nothing
now proves that Prisma issues the query the plan describes for a nested compound `where`. Given no
tenant-owned model has such a constraint, there is nothing to prove it against; inventing a schema
constraint for the test's benefit would be worse. **Not a finding, recorded as checked.**

### F-7 — cross-tenant isolation: the tests exist, but they cannot fail for the application layer alone.

`invitations.integration.spec.ts` carries the two `CLAUDE.md`-mandatory arms:

```
787:  it('CROSS-TENANT — shows nothing of another organisation, and 404s its path id', …
880:  it('CROSS-TENANT — Tenant A gets 404 for Tenant B's invitation id, and it survives', …
```

The revoke arm is the good one: it uses B's invitation id under **A's own path** (the shape an
attacker actually has, since B's path id is refused earlier by `assertPathIsActiveTenant`), asserts
404 with `RESOURCE_NOT_FOUND`, asserts the body is byte-identical to the refusal for an id that
does not exist, and then asserts B's row still has `revokedAt IS NULL`. That last assertion is the
one that makes it a real isolation test rather than a status-code test.

The honest limitation, which is a property of the design and not a defect in the test:
**three layers hold that boundary** — the explicit `organizationId` in the `where`, the tenant
client's scoping extension, and `FORCE ROW LEVEL SECURITY` on `Invitation`. Removing any single one
of them leaves the test green, because the other two still refuse. So the test guards the
*outcome*, not any one layer. That is the right thing to assert at this level and the file says as
much ("three layers, all stated"); I record it so nobody reads a green cross-tenant test as
evidence that the application-level predicate is load-bearing. **INFERRED** — I did not run the
three single-layer mutations, which would need an integration run each.

### F-2, correction to my own finding (written after reading the controller)

`invitations.controller.ts`'s class docblock **does** record the cost F-2 describes:

> "The cost of that class having no `perIp` window is worth stating: an unauthenticated flood at
> this route pays authentication, tenant resolution and the permission check before anything
> refuses it. That is no worse than the `generalSession` default, which is fail-open and
> (carry-forward ruling 55) resolves nothing — but it is not better either…"

So F-2 is **not** an undocumented consequence in the codebase; it is undocumented in ADR-0023,
which is the document a reader goes to for this decision. F-2's severity stands at Medium on that
basis alone, and its "the ADR presents the placement as a pure win" sentence is the accurate part.

One residual defect in that controller sentence, though: **an unauthenticated flood does not reach
tenant resolution or the permission check.** `AuthenticationGuard` refuses it at 401, two stages
earlier. The population that reaches "authentication, tenant resolution and the permission check
before anything refuses it" is the **authenticated** one — a signed-in member without
`organization.manage_members`, or with an unverified address. The sentence names the cheaper attack
and misses the more expensive one. **Low, INFERRED** from the asserted guard order.

### F-8 — D4 (supersede) and D5 (no minting): both hold; the lock key matches `TokenService`'s.

**D5, an `ADMIN` may not invite an `OWNER`.** `invitation.service.ts` `create` reads the offered
role's permissions from the seeded `RolePermission` rows and calls the imported
`assertActorMayGrant(ctx, …)` — the same function, not a copy (`import { assertActorMayGrant } from
'../memberships/membership.service.js'`). The test is a good one
(`invitations.integration.spec.ts:339`): 403 `PERMISSION_DENIED` naming `organization.delete`,
**plus** an ADMIN successfully inviting an ADMIN (so the refusal is about the set comparison and not
about the verb), **plus** an assertion that exactly one `MEMBER_INVITED` row exists afterwards, so
the refused transaction is proved to have rolled back with its audit row.

**The advisory-lock key derivation matches `TokenService.issue`'s, shape for shape.** MEASURED:

```
token.service.ts:245
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`vtk:${userId}:${purpose}`}))) AS lock_taken`;
invitation.service.ts (lockInvitationSlot)
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`inv:${organizationId}:${email}`}))) AS lock_taken`;
```

Same function (`pg_advisory_xact_lock`, transaction-scoped, released at commit), same `hashtext`
derivation, same subquery wrapper for the `void`-deserialisation trap, same tagged-template
parameterisation. The prefixes differ (`vtk:` / `inv:`), so the two families cannot collide by
construction on their prefix; `hashtext` is 32-bit so a cross-family collision remains possible and
its only cost is that two unrelated pairs serialise for the length of one transaction — the same
trade `TokenService` already accepted and this file's docblock restates. **No finding.**

**Is D4's correctness observable today, with no accept endpoint?** Partly, and the distinction
matters:

- **Observable:** the superseded row's `revokedAt` is set in the same transaction as the new
  invitation, exactly one live row survives per `(organizationId, email)`, an expired row is
  superseded too, and `MEMBER_INVITED.metadata.supersededInvitationId` names the row that died.
  Tests at `:375`, `:428` and `:571` assert these.
- **NOT observable:** that the superseded **token stops working**. `security/authentication.md` §6's
  property is "invalidated by use or by a newer token", and invalidation is only meaningful at the
  consumer. There is no consumer. So what is proved today is that a column was written; that the
  column is honoured on acceptance is owed to whoever builds `accept`, alongside D9. The report does
  not make this distinction — its §1 lists accept-dependent tests but presents D4 as done.
  **Low, INFERRED.**

---

## Area 3 — mutation discipline, re-run independently

Baseline first: `npx vitest run --project integration apps/api/src/modules/invitations/invitations.integration.spec.ts`
→ **EXIT=0, 20 passed (20)**, 14.0s wall. Every mutation below was applied to the working tree, the
suite re-run, then the file restored from a backup copy taken before the first mutation, and
`git status --short` confirmed empty. Final restore verified with a green re-run (EXIT=0, 20/20).

| # | Mutation | Runs | Result | Report's claim | Verdict |
|---|---|---|---|---|---|
| M1 | `lockInvitationSlot` body replaced with a no-op | 3 | **1 red every run** (`BLOCKS while another session holds the advisory lock…`); the `Promise.all` arm also went red on **1 of 3** | "1 red on every one of 3 runs once the advisory-lock detector was added" | **reproduces** |
| M2 | `deletedAt: null` removed from `assertNotAlreadyAMember` | 2 | **GREEN both runs, 20/20** | "**1 red** — the ruling 99/100 test" | **DOES NOT REPRODUCE — F-9** |
| M3 | `status: 'ACTIVE'` removed, `deletedAt: null` kept | 1 | **GREEN, 20/20** | not claimed | new measurement |
| M4 | **both** predicates removed | 1 | **1 red** (`RULING 99/100 — re-invites a REMOVED member…`) | — | this is the real guard |
| M5 | supersede `updateMany` disabled (`if (false && superseded !== null)`) | 1 | **3 red** — supersede, expired-supersede, and the two-at-once arm | "**3 red** — supersede, expired-supersede, and the two-at-once arm" | **reproduces exactly** |

### F-9 — the ruling-99 `deletedAt` predicate is NOT guarded, and the report's mutation row for it is false. **Medium. MEASURED.**

Report §9 row 1:

> | `deletedAt: null` removed from `assertNotAlreadyAMember` | invitations integration | **1 red** — the ruling 99/100 test |

Re-run:

```
$ python -c "…replace   where: { organizationId, userId: user.id, status: 'ACTIVE', deletedAt: null },
                  with   where: { organizationId, userId: user.id, status: 'ACTIVE' },…"
MUTATED: deletedAt predicate removed
$ npx vitest run --project integration …/invitations.integration.spec.ts     RUN 1 EXIT=0   Tests 20 passed (20)
$ npx vitest run --project integration …/invitations.integration.spec.ts     RUN 2 EXIT=0   Tests 20 passed (20)
```

**The mutation survives.** The reason is measurable and I measured it: the two terms in that
predicate are mutually redundant for the scenario the test arranges. Dropping `status: 'ACTIVE'`
and keeping `deletedAt: null` is **also** green (M3); only dropping **both** goes red (M4). A
removed membership is `status: 'REMOVED'` *and* soft-deleted — the CHECK constraint the service's
own docblock cites ties the two together — so either term alone excludes the removed row and the
test cannot tell which one is doing the work.

Consequences, in order of importance:

1. **Ruling 100 is violated on the exact predicate D7 exists to protect.** "A test that passes under
   the mutation is not a guard" — the brief says it, the service docblock says it
   (`assertNotAlreadyAMember`'s comment: "A test arranged the other way passes under the mutation"),
   and the guard the sentence describes does not exist. Delete `deletedAt: null` tomorrow and CI
   stays green.
2. **The report asserts a red run that does not happen.** This is a fabricated measurement in a
   mutation table, which is the highest-trust kind of claim in this project's reports — the whole
   point of ruling 100 is that the table is the evidence.
3. The *behaviour* is currently correct; the second term is redundant belt-and-braces, and the
   service docblock explicitly anticipates the day it stops being redundant ("Nothing writes
   `MembershipStatus.INVITED` today … the day something does, an invitation is not a membership and
   must not block a second one"). That is exactly the future in which the untested term matters,
   which is why this is Medium rather than Low.

A test that would bite: arrange a membership that is `deletedAt: NOT NULL` but **not** `REMOVED`, or
one that is `INVITED` and live. Neither is currently producible through the API — which is itself
the honest answer, and would have been a better report row than a red run that did not occur.

### F-1 upgraded to MEASURED — an expired invitation's revoke answers 204

I added one temporary probe to `invitations.integration.spec.ts` asserting the docblock's claimed
404 for an expired invitation, ran the file, and removed the probe:

```
× DELETE /api/v1/organizations/:id/invitations/:invitationId
  > REVIEW PROBE — what does revoking an EXPIRED invitation actually answer?
  → expected 204 to be 404 // Object.is equality
Tests  1 failed | 20 passed (21)
```

**The endpoint answers 204 and writes an `INVITATION_REVOKED` audit event.** The docblock on
`InvitationService.revoke` and report §4 item 7 are both false. Spec file restored;
`git status --short` empty; re-run green (EXIT=0, 20/20).

### M1's incidental result, worth carrying

With the lock disabled, the `Promise.all` arm ("does not leave two live invitations for one
address") went red on **1 run of 3**. That independently corroborates the report's central
finding — that arm alone is a coin flip and the session-level advisory-lock blocker is what made
the guard deterministic. The replacement detector went red on 3 of 3. **The report's headline
mutation claim is sound and the added detector is a real guard.**

---

## Area 2 — judging the `SECURITY DEFINER` lookup (`20260904020000_invitation_lookup_function`)

### Does it leak anything?

No, on the terms it sets. It returns one `text` column and no row data. Measured (probe table in
C-4): a wrong hash returns `NULL`, a correct hash returns the organisation id with no
`app.organization_id` set. The argument is a SHA-256 of 256 bits of `randomBytes` output
(`secret-token.ts`), so there is no enumeration path and no oracle a caller does not already have
the answer to.

Two narrow observations, neither rising to a finding:

- The function filters on **nothing but the hash** — an accepted, revoked or expired invitation's
  token still resolves its organisation id. That is deliberate and stated in the migration comment
  ("It makes no policy decision"). The disclosure is one opaque id to someone who already held the
  credential. **Not a finding.**
- `RETURNS text` over a `SELECT` with no `LIMIT`: a multi-row result would silently return the first
  row rather than erroring. `Invitation_tokenHash_key` is UNIQUE (confirmed in `\d "Invitation"`),
  so it cannot happen. **Not a finding**, recorded because the guarantee lives in an index, not in
  the function.

### Can it be abused?

`REVOKE EXECUTE … FROM PUBLIC` then `GRANT … TO sentinel_app` is present and effective:

```
proacl = {sentinel_org_lookup=X/sentinel_org_lookup, sentinel_app=X/sentinel_org_lookup}
```

PUBLIC holds no EXECUTE. `sentinel_org_lookup` is `NOLOGIN` (`rolcanlogin = f`), so the owner
cannot connect. The only caller is the API process.

**The abuse surface that matters is not the function — it is what the handler does with its
result, and ADR-0022's second property overstates the containment.** The ADR says:

> "…all they learn is an opaque organisation id **they cannot act on** — every subsequent read and
> write in the accept path runs under RLS in a transaction scoped to that id."

`withTenantTransaction(base, organizationId, fn)` (`packages/db/src/tenant-transaction.ts:33-44`)
takes a raw id and performs **no membership or entitlement check** — it calls
`set_config('app.organization_id', <id>, true)` and hands the callback a scoped client. RLS scoped
to an organisation does not restrict the caller *within* that organisation; it restricts them *to*
it. So the accept handler will open a fully-privileged tenant transaction into an organisation the
authenticated user is a member of nothing in, chosen by a value derived from a client-supplied
token. Every tenant-owned row in that organisation — `Membership`, `Invitation`, `AuditEvent` — is
readable and writable inside that transaction, and the only thing that stops it is the handler
being written not to.

That is the same posture ADR-0020's `user_organizations` has and it is probably acceptable, but the
ADR's "cannot act on" is the wrong description of why, and it is the sentence a later reader will
lean on when adding the fourth definer function. The accurate statement is: **containment is the
handler's discipline, not RLS.** `assertPathIsActiveTenant` — the check that makes every other
tenant route safe — has nothing to compare against here, because there is no path id and no
resolved tenant. **Medium, INFERRED (from the two function bodies; there is no accept handler to
measure).**

### Is `search_path = public, pg_temp` correct?

Yes, and it is what ADR-0021 requires. Confirmed in the live catalogue rather than in the file:

```
 proname                               | owner               | prosecdef | proconfig
 user_organizations                    | sentinel_org_lookup | t         | {"search_path=public, pg_temp"}
 invitation_organization_by_token_hash | sentinel_org_lookup | t         | {"search_path=public, pg_temp"}
```

`pg_temp` is last, so an unqualified `"Invitation"` resolves in `public` first. The second,
independent defence the migration comment claims is also real:

```
 has_database_privilege('sentinel_app','sentinel','TEMPORARY') = f
 has_database_privilege('public','sentinel','TEMPORARY')       = f
```

### Are the grants right?

Yes. `sentinel_org_lookup` holds SELECT on exactly three tables and nothing else:

```
 sentinel_org_lookup | Invitation   | SELECT
 sentinel_org_lookup | Membership   | SELECT
 sentinel_org_lookup | Organization | SELECT
```

which matches ADR-0022's Consequences exactly. No default privileges were granted, so the claim
that a later migration's table stays invisible holds.

### Is it sufficient for the accept path to be built on?

Sufficient for the **lookup**, yes — probe rows B and D together show the whole sequence works:
resolve the id with the definer function, then read the full row and write `Membership` and
`AuditEvent` under ordinary RLS inside `withTenantTransaction(that id)`. `User` is not tenant-owned
and carries no policy, so the invited-address comparison (D11) needs nothing extra.

Two things it does **not** unblock, and only one of them is recorded:

1. `lockOrganization` is still not exported. **Verified**: `membership.service.ts:156` reads
   `async function lockOrganization(tx: TenantTransaction, organizationId: string): Promise<void>`
   with no `export` keyword. D8 requires acceptance to take that lock and `permissions.md` invariant
   1 names Task 15 as the next taker. The report flags this (§6); the migration and both ADRs do
   not.
2. Nothing in the schema, the function, or either ADR constrains the accept handler to compare the
   invited address to the authenticated user's (D11). That is the whole security of the endpoint
   and it is entirely unwritten code. Stating the obvious because the branch's documents now read
   as though acceptance is unblocked: **the blocker was one of three, and the other two are the
   lock and D11.**
