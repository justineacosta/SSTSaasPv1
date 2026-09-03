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
