# Task 14 fix round — what was changed and what measured it

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the fix implementer on 2026-09-03, on branch `feat/phase-2-task-14-memberships`,
starting from `c9ca085`. **Eight** commits: seven of code and documentation, `2ec65c0` through
`97781b3`, and the one that adds this file. Nothing merged, pushed,
branched or rebased.

Work list: [`fix-brief.md`](fix-brief.md). Every finding below is the fix brief's, in its order,
with what changed and the measurement that closed it. **No disposition was disputed.** One
disposition was extended, and one false sentence outside the fix brief's list was found and
corrected while correcting one that was on it; both are stated in their own sections.

---

## 1. Evidence table

Every command run from the repository root with `out=$(pnpm <cmd> 2>&1); code=$?`, so the exit
code is the command's own and not a pipe's last stage.

| Command | Exit | Measured | What it proves |
|---|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | Nothing added or edited is unformatted. |
| `pnpm lint` | 0 | (silent) | No ESLint error, including `no-restricted-imports` and the cross-module boundary rule. |
| `pnpm typecheck` | 0 | 14 tasks | `tsc --noEmit` under strict mode across the workspace. |
| `pnpm test` | 0 | 99 files / **1673** tests (from 98 / 1668) | Unit lane green. +1 file, +5 tests: `organization-switch.service.spec.ts`. |
| `pnpm check:specs` | 0 | **126** spec files (from 125) | The one new spec file is claimed by exactly one Vitest project. |
| `pnpm test:integration` | 0 | 27 files / **485** tests (from 27 / 479) | See §2 — run three times end to end. +6 tests, no new file. |
| `pnpm build` | 0 | 8 tasks successful | API and web compile. |
| `pnpm check:openapi` | 0 | `"routes":24` | The committed `openapi.json` matches what the contracts generate. Unchanged count; the `DELETE` description and its 403 changed and were regenerated. |
| `pnpm check:registry` | 0 | **15 models**, 3 tenant-owned, 1 root, 11 global | Unchanged, as the brief required. No table, no column. |
| `pnpm check:secrets` | 0 | **446** tracked files (from 445) | +1 is the one new source file. No credential-shaped literal. |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit — all `Up 36 hours (healthy)` | The stack the integration lane needs was live throughout. |

**No migration was written and none was needed.** `check:registry` reporting 15 is the check on
that claim.

---

## 2. The three `pnpm test:integration` runs

Run end to end, one after another, after the last commit. HIGH-1 is the reason this is three runs
and not one.

| Run | Exit | Test files | Tests |
|---|---|---|---|
| 1 | **0** | 27 passed (27) | 485 passed (485) |
| 2 | **0** | 27 passed (27) | 485 passed (485) |
| 3 | **0** | 27 passed (27) | 485 passed (485) |

No failures in any run. The `auth.mfa.integration.spec.ts` flake the brief exempts did not appear.

There were three further full-lane runs earlier in the round, immediately after HIGH-1's commit and
before anything else was touched — `EXIT=0`, 27 files / 479 tests, three times — which is the
measurement that established a green lane to build on.

---

## 3. HIGH-1 — the one-sided barrier. **Fixed.**

`last-owner.integration.spec.ts`'s unlocked race arm used a deferred promise Alice opened and then
immediately fell through. Nothing made Alice wait for Bob to have counted, so a Bob slow to acquire
a connection took his snapshot after Alice's commit, counted one owner and returned without
writing.

Replaced with a **counting barrier**: `arrive()` releases nobody until both participants have
called it, so neither transaction can leave it until both have counted. The comment above it — which
claimed the interleaving was "arranged rather than hoped for" — now describes what the code does,
and records what the old gate actually guaranteed.

**Measured, on the file alone:**

| State | Exit | Result |
|---|---|---|
| One-sided gate + 500 ms delay before Bob's count (the review's deterministic repro) | **1** | 1 failed / 4 passed (5), `AssertionError: expected 1 to be 2` at `:212` |
| Counting barrier + **the same 500 ms delay** | **0** | 5 passed (5) |
| Counting barrier, delay removed, ten consecutive runs | **0** | every run |

The middle row is the demonstration the fix brief asked for, taken from the other direction: rather
than removing the barrier and watching flakiness return, the barrier was left in place and the
exact perturbation that made the old gate fail deterministically was applied to it. It absorbs it.
The first row is the same file with the barrier removed, which is the "watch it become flaky again"
measurement — and it is not flaky, it is red every time under that delay.

## 4. HIGH-2 — no deterministic detector for `updateRole`'s lock. **Fixed.**

The one deterministic detector issued a `DELETE`. A second arm now issues the `PATCH` behind a
blocker holding `SELECT ... FOR NO KEY UPDATE` on the `Organization` row, so a handler that takes
`FOR UPDATE` cannot answer while it is held. `FOR NO KEY UPDATE` and not `FOR UPDATE`, for the
reason the implementer found and the review restated: `withScopedData` forces `organizationId` into
the payload, Postgres re-checks the foreign key and takes `FOR KEY SHARE` on the parent row, and a
`FOR UPDATE` blocker would stall the request whether or not the handler locked anything.

**Mutation — `await lockOrganization(...)` deleted from `updateRole` only, `remove` untouched:**

| Target | Exit | Result |
|---|---|---|
| memberships lane, before this round | 0 | 36 passed (36) — the review's measurement, nothing red |
| memberships lane, with the new arms | **1** | 2 failed / 36 passed (38) |
| `last-owner.integration.spec.ts` alone, 5 runs | **1, 1, 1, 1, 1** | the role-change detector red in **5 of 5** |

The failing names, captured per run: `a role change waits for a lock held on the organisation row`
in all five; `a removal racing a demotion of the other remaining owner...` in all five;
`two concurrent demotions...` in one of five, which is the `Promise.all` non-determinism the report
already concedes.

Restored: memberships lane `EXIT=0`, 38 passed (38).

## 5. MEDIUM-3 — "nothing can mint a session pointed here afterwards". **Fixed, code first, then all three sentences.**

### 5.1 The window, reproduced

A 2 s delay was instrumented in `OrganizationSwitchService.switch` between the membership read and
`rotate`, and a scratch integration spec arranged the interleaving: Bob, a member whose session
points at **no** organisation, starts a switch; 500 ms later Alice removes him. The scratch spec was
deleted before the final verification and appears in no commit.

**Before the fix:**

```json
{ "switchStatus": 200,
  "switchBody": { "activeOrganization": { "id": "org_…", "slug": "race-…", "name": "Race …" },
                  "permissions": [ 23 keys ] },
  "removalStatus": 204,
  "membershipRow": { "status": "REMOVED", "deletedAt": "2026-09-03T06:19:29.697Z" },
  "liveSessionsPointedAtOrg": [ { "id": "ses_…", "status": "ACTIVE", "revokedAt": null } ],
  "authSessionStatus": 200,
  "authSessionBody": { "activeOrganization": { "id": "org_…", "slug": "race-…", "name": "Race …" },
                       "permissions": [] } }
```

The review's measurement reproduced exactly, and one thing it did not record: the switch's own 200
response carried a **populated 23-permission set** to the removed member, because the document was
built from the first read.

### 5.2 The fix

Ruling 82's shape, which is `login.service.ts`'s `credentialStillCurrent` applied to membership.
After `rotate` returns, `switch` re-resolves through the **same** `TENANT_RESOLVER` and
`resolveTenant`; if that read does not resolve it revokes the session it has just issued, logs a
warning naming the user, organisation and session id and nothing else, and throws. Both refusals —
the first read's and the re-read's — are now built by one function, so a caller cannot tell them
apart. The re-read runs **before** the audit write, so a switch that is taken back leaves no
append-only row saying it happened. The document and the audit row are built from the re-read's
context, which is the fresher of the two.

### 5.3 The measurement that it is closed

Same instrumented delay, same scratch spec, three consecutive runs:

| Run | `switchStatus` | `liveSessionsPointedAtOrg` | successor session |
|---|---|---|---|
| 1 | **404** `RESOURCE_NOT_FOUND` | `[]` | `revokedAt` set |
| 2 | **404** `RESOURCE_NOT_FOUND` | `[]` | `revokedAt` set |
| 3 | **404** `RESOURCE_NOT_FOUND` | `[]` | `revokedAt` set |

Both of the user's session rows carry `revokedAt` — the predecessor by `rotate`, the successor by
the new check. No `Set-Cookie` for a session cookie is returned, so there is no credential to probe
`GET /auth/session` with; the probe reports `-1`, meaning it was never issued.

**A consequence, stated rather than buried:** when this fires the caller is signed out entirely,
because `rotate` has already revoked the predecessor. That is stricter than the removal's own
revocation, which spares a session pointed elsewhere. Ruling 95 is not violated — the account is
untouched and signing in works — and it is recorded in the service docblock.

### 5.4 The committed regression test

`apps/api/src/modules/auth/organization-switch.service.spec.ts`, 5 arms: the membership removed in
flight (404, revoked, `rotate` ran first, one warning), the membership row absent entirely, the
organisation suspended in flight (403, revoked), the two refusals compared field by field, and
`rotate` returning `null` (401, no re-read, no revoke). Each arm asserts the rotation happened, so a
green tick cannot be produced by the first read refusing — ruling 58.

**Why a unit spec, said plainly:** the window is microseconds wide and an integration test cannot
land in it without instrumenting the service under test. What is deterministic is the decision, and
that is what these arms hold. The ordinary path is held by
`auth.switch-org.integration.spec.ts` — `EXIT=0`, 14 passed — which was re-run after the change.

**Mutation** — the re-read block deleted, the happy path falling back to the first read's context:
`EXIT=1`, **4 failed / 1 passed (5)**. Restored: `EXIT=0`, 5 passed.

### 5.5 The sentences

Three were named by the fix brief and a fourth was found while correcting them:

1. `membership.service.ts`'s closing comment on `remove` — rewritten to say that this `updateMany`
   is not what stops a racing switch, that the earlier argument was ruling 82's struck-down shape,
   and that what closes it lives in `organization-switch.service.ts`.
2. `session.service.ts`'s "Task 14's member removal is the next one, and its equivalent does not
   exist yet" — the equivalent now exists; the sentence records that it arrived in the fix round
   rather than in Task 14, and that this file was right while the membership service three files
   away was wrong.
3. `.claude/product/permissions.md` invariant 5 — rewritten around the measurement, including what
   the old paragraph asserted and why it was false, and separating the compensating layer (authority
   re-read per request, so no tenant data was reachable) from the property that now holds.
4. **`.claude/security/authentication.md`** said the same thing in the same words —
   "**Task 14's member removal is the next one**, and its equivalent does not exist". Not on the fix
   brief's list; corrected in the same change, because leaving it would have been this round's own
   defect class.

## 6. MEDIUM-4 — a miscount invented inside ruling 108's comment. **Corrected.**

Verified against history rather than reasoned about:

```
git show 21f629f:…/audit.actions.ts  →  "All four actions above are events about an `Organization`"
                                        with AUDIT_ACTIONS holding THREE names
git show c10eeab:…                   →  corrected to "All three"
git show 01dfe99:…                   →  "All three actions above…", AUDIT_ACTIONS THREE, correct
```

So there was one miscount, not two: "all four" of a constant holding three. The sentence Task 14
claimed to be correcting — "all three" of a constant holding two — never existed; "all three"
described the actions and was right about them. The comment now states that history with both
commit SHAs and says not to invent a second error to make the first rhyme.

The counts the comment states, recomputed from the file rather than read: `AUDIT_ACTIONS` **5**,
`AUDIT_RESOURCE_TYPES` **2**. `.claude/security/audit.md`, which the review found already correct,
is unchanged.

## 7. MEDIUM-5 — "34/34 passing" is 36. **Corrected.**

`report.md` §3.1 corrected to 36, with a note giving the two independent measurements and the
report's own arithmetic (443 → 479 across the two new files) that implies it. The substance of §3.1
— M6 survives, and the CHECK constraint is why — is unchanged and was not disputed.

## 8. LOW-1 and LOW-2 — stale and incomplete citations. **Corrected, and the rule changed rather than the two entries.**

`product/permissions.md:104` was a blank line and `security/authorization.md:262` an unrelated
sentence; both were correct at `01dfe99` and were moved by Task 14's own documentation commit
`7ef117b`. `authorization.integration.spec.ts` is at `apps/api/src/modules/roles/`, not
`apps/api/src/common/`.

**And the same defect bit two more entries during this round**, which is why the rule changed:
MEDIUM-3's change edited `session.service.ts` and `security/authentication.md`, so
`session.service.ts` 695/711/736 and `security/authentication.md:537` stopped resolving — line 736
had become a closing brace. Every citation in that list naming a file this round touched is now a
quoted phrase. The three that remain line numbers name files nothing here edited, and each was
re-run and confirmed after the last commit:

| Citation | Verified reads |
|---|---|
| `session.repository.ts:121` | ``* (`permissions.md` invariant 5, Task 14); it is not tenant scoping.`` |
| `tenant-resolver.store.ts` 30, 86 | ``* `invalidate()` for Task 14's role change…`` / ``// row — which is exactly what Task 14's member removal…`` |
| `roles/authorization.integration.spec.ts` 340, 445 | ``* for a member who is active. This is the shape Task 14's removal…`` / ``* There is no permission cache and therefore no `invalidate()` for…`` |

## 9. LOW-3 — the lock is taken before the membership is resolved. **Accepted, and the reasoning is now in the docblock.**

No code change, which is the disposition. `lockOrganization`'s docblock now states the residual
(a privileged caller can serialise the tenant's membership writes by naming ids that do not exist),
the alternative and why it is worse (resolving first puts the owner count outside the lock, which is
the defect D1 exists to close), and the instruction not to turn it into a conditional lock.

## 10. LOW-4 — the docblock claimed a predicate the role-change write did not carry. **Fixed in the code, not in the sentence.**

`updateRole`'s `update` now carries `organizationId` and `deletedAt: null` alongside the id, so
`assertOrganizationKeepsAnOwner`'s docblock claim that every `Membership` statement in the file
carries them is true. Prisma's extended `where` on `update` accepts them; `pnpm typecheck` exit 0.

**This is a known surviving mutation and it is stated in the comment beside the predicates.**
Deleting both turns nothing red — memberships lane `EXIT=0`, 42 passed (42) — because the row was
resolved live by `liveMembership` in the same transaction under the organisation lock, and the only
writer that can soft-delete it takes the same lock. It is unreachable rather than untested. What it
buys is that a later writer who skips the lock fails loudly instead of updating a removed row.

## 11. LOW-5 — no removal-racing-demotion arm. **Fixed.**

Added. The winner is whichever transaction takes the lock first, so the arm asserts the shape that
holds either way: exactly one 422, exactly one success (204 or 200), and one live owner left. It went
red in 5 of 5 runs under HIGH-2's mutation, but it is a `Promise.all` and is therefore recorded as an
end-to-end sanity check rather than as a deterministic detector — the deterministic ones are the two
lock-blocking arms.

## 12. Ruling — an `ADMIN` may not remove an `OWNER`. **Implemented.**

`remove` now applies D5's own helper to the role the **target** holds: an actor may not remove a
member whose role carries a permission the actor does not hold. One helper, not a second copy; a set
comparison, not a ranking. The permissions come from the seeded `RolePermission` rows, so both sides
of the comparison have the same origin as `ctx.permissions` — the same read the `PATCH` does.

The refusal order in `remove` now mirrors `updateRole`'s: path id (404), membership (404), authority
(403), last-owner (422).

Four integration arms, and the three that pass are as load-bearing as the one that refuses:

| Arm | Status |
|---|---|
| `ADMIN` removing an `OWNER` | **403** `PERMISSION_DENIED`, `required: organization.delete`, target still `ACTIVE` with `deletedAt` null, zero `MEMBER_REMOVED` events |
| `ADMIN` removing an `ADMIN` | 204 — equal sets. This is the arm a role ranking would fail |
| `ADMIN` removing themselves | 204, row `REMOVED` with `deletedAt` set, their session for the organisation carries `revokedAt` |
| `OWNER` removing an `OWNER` | 204 — the rule refuses reaching upwards, not sideways |

**Mutation** — the authority check deleted from `remove`: memberships lane `EXIT=1`, 1 failed / 41
passed (42), the failing arm being `refuses an ADMIN removing an OWNER with 403`. Restored:
`EXIT=0`, 42 passed.

## 13. Ruling — self-removal is permitted. **Documented.**

Stated in the `DELETE` handler's docblock, in its OpenAPI description (regenerated; `check:openapi`
still 24 routes), in `membership.service.ts`'s `remove` docblock, and in `permissions.md`. The
authority check never refuses it, because an actor's own role is an equal set to itself, and the
last-owner invariant refuses the only dangerous case. Held by the self-removal arm in §12.

---

## 14. Every mutation run in this round, and the survivors

| # | Mutation | Target | Exit | Went red |
|---|---|---|---|---|
| F1 | One-sided gate + 500 ms delay before Bob's count (the pre-fix state) | `last-owner` file | 1 | 1: the unlocked race arm — red deterministically |
| F2 | Counting barrier + the same 500 ms delay | `last-owner` file | 0 | nothing — **the intended result**: the barrier absorbs the perturbation that killed the gate |
| F3 | `await lockOrganization(...)` deleted from `updateRole` only | memberships lane | 1 | 2 of 38 |
| F3 | the same, `last-owner` file, 5 runs | `last-owner` file | 1 ×5 | the role-change lock detector **5 of 5**; the mixed arm 5 of 5; the demotion pair 1 of 5 |
| F4 | The post-rotate re-read block deleted | `organization-switch.service.spec.ts` | 1 | 4 of 5 |
| F5 | The authority check deleted from `remove` | memberships lane | 1 | 1 of 42 |
| **F6** | `organizationId` and `deletedAt: null` deleted from `updateRole`'s `update` | memberships lane | **0** | **nothing — SURVIVOR** |

**One survivor, F6**, and it is §10's, stated in the comment beside the code rather than papered
over: the predicates are unreachable while the organisation lock stands, so no test can distinguish
their presence. They are defence against a future writer that skips the lock, not against anything
reachable today. This is the same category as the implementer's M6, which was re-confirmed by the
review and is untouched here.

Every mutation was applied to the working tree, measured, restored, and `git status` confirmed clean
before the next one.

---

## 15. What I did not do, named plainly

1. **`roadmap.md` is untouched and no status prose was written**, per the fix brief. Every sentence
   asserting where this task stands is the orchestrator's.
2. **No trigger was added** as D1's optional second layer. Unchanged from the implementer's
   residual 5, and nothing in this round's findings asked for it.
3. **The report's §7 residuals 1 and 2 were left standing.** They were true statements about what
   the implementer did and did not do, in a dated record; the rulings that supersede them are in
   `fix-brief.md` and their implementation is in §12 and §13 above. Only the figures the fix brief
   dispositioned as CORRECT were edited in `report.md`.
4. **`apps/web` is untouched.** The members screen is Task 17.
5. **The MEDIUM-3 measurement cannot be re-run from a committed test.** It needs the 2 s
   instrumentation, and the scratch spec that carried it was deleted. What is committed is the unit
   spec of §5.4; what is recorded is the transcript in §5.1 and §5.3. A reader who wants to
   reproduce it has to re-instrument.
6. **F6 survives** (§10, §14).
7. **`git status` was clean before this file was written**, and the commit that adds it is the
   eighth — the seven listed above plus this one. The count is stated after counting `git log`,
   because a ledger file that miscounts its own commits is how this phase has repeatedly gone
   wrong.
