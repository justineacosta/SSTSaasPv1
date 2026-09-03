# Task 14 adversarial review — Memberships, roles, and the last-owner invariant

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a fresh adversarial reviewer on 2026-09-03, on branch
`feat/phase-2-task-14-memberships` at `b58cc74`. Range reviewed: `0739af9..HEAD`, of which
`1f2239e`..`b58cc74` is Task 14's own work. The reviewer wrote none of this code.

Every finding below carries the command that produced it. Mutations were applied to the working
tree, measured, and reverted with `git checkout --`; `git status` was confirmed empty after each.

---

## 0. Findings by severity

| Severity | Count |
|---|---|
| Critical | 0 |
| High | **2** |
| Medium | **3** |
| Low | **5** |

Plus **four false or stale factual claims** from the citation pass (three of them are the
Medium/Low findings themselves; one is listed separately), and rulings on the two questions the
implementer flagged rather than decided.

---

## 1. HIGH — `pnpm test:integration` goes red on this tree, and the red test is Task 14's own

The orchestrator's baseline records `test:integration` as 27 files / 479 tests, exit 0. Re-run on
this exact tree, unmodified:

```
out=$(pnpm test:integration 2>&1); code=$?
EXIT=1

 ❯ apps/api/src/modules/memberships/last-owner.integration.spec.ts:211:23
    210|     expect(seenByAlice).toBe(2);
    211|     expect(seenByBob).toBe(2);
       |                       ^
AssertionError: expected 1 to be 2
- 2
+ 1

 Test Files  1 failed | 26 passed (27)
      Tests  1 failed | 478 passed (479)
```

The failing test is *WITHOUT the row lock, two concurrent demotions both commit and the
organisation is left with ZERO owners* — the test the report calls "the one that makes the others
mean anything" and D2 calls the thing that must fail before the locked version proves anything.

**It is intermittent, and here is the whole sample rather than the convenient half of it.** Two
full-lane runs on this tree: the first `EXIT=1` as above, the second `EXIT=0`, 27 files / 479
tests. Three consecutive runs of `last-owner.integration.spec.ts` alone: `EXIT=0`, 5/5, every
time. So it is not "always red" — it is a coin toss weighted by how busy the machine is, which is
worse, because it is the shape that survives a re-run and reaches `main`.

### 1.1 The mechanism, proved

The gate the test uses is a **one-sided barrier**. `last-owner.integration.spec.ts:186-191`:

```ts
if (after === 'first') {
  bothCounted.open();
}
await bothCounted.wait;
if (after === 'second') await aliceWrote.wait;
```

Alice opens `bothCounted` and immediately proceeds to her `UPDATE`. **Nothing waits for Bob to
have counted.** `bothCounted` guarantees only "Alice has counted", not "both have counted". If
Bob's connection acquisition or transaction start lags — which is exactly what happens under a
loaded lane — Bob takes his snapshot *after* Alice's commit, counts 1, and returns without
writing.

Measured by making Bob start late. One line inserted before Bob's count:

```ts
if (after === 'second') await new Promise((r) => setTimeout(r, 500));
```

```
EXIT=1
× WITHOUT the row lock, two concurrent demotions both commit ... ZERO owners  551ms
AssertionError: expected 1 to be 2
Test Files  1 failed (1)   Tests  1 failed | 4 passed (5)
```

Reverted; tree clean.

### 1.2 Why this is High and not Low

Three separate things:

1. **The merge gate fails intermittently.** `pnpm test:integration` is one of the commands the
   brief's §7 requires to exit 0, and it did not on one of two runs here. A gate that is right half
   the time is not a gate.
2. **The comment above the gate asserts the opposite of what the gate does.** Lines 183-186:
   *"Both transactions must have counted before either writes, which is the interleaving that
   produces the anomaly. Arranged rather than hoped for — a race test that depends on timing
   reports green on the machine that is fast enough."* It is hoped for, and it reports green on the
   machine that is fast enough. This is carry-forward ruling 109's shape applied to the file's own
   headline evidence.
3. **The report's §7.3 residual is wrong about which tests are non-deterministic.** It names the
   two `Promise.all` tests and presents the two raw-Postgres tests as arranged. One of the two
   raw-Postgres tests is the flakiest thing in the range.

**Who it breaks:** anyone who runs the lane. CI fails on a green branch, intermittently, on a test
whose failure message reads like a real anomaly. This is the failure mode that trains people to
re-run rather than read.

**Not the known flake.** The brief exempts `auth.mfa.integration.spec.ts`. This is not that file.

---

## 2. HIGH — the role-change path's row lock has no test that can detect its removal

D1: *"Take a row lock on `Organization` at the start of **every** membership write that can change
the owner count — role change and removal both."* The lock is taken on both. But only one of the
two is guarded by a test that goes red when it disappears.

Mutation applied — the lock removed from `updateRole` **only**, `remove` left untouched:

```diff
   return withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
-    await lockOrganization(tx, ctx.organizationId);
-
     const membership = await liveMembership(tx, ctx.organizationId, membershipId);
```

```
pnpm vitest run --project integration apps/api/src/modules/memberships
EXIT=0
Test Files  2 passed (2)
      Tests  36 passed (36)
```

**Nothing red.** The whole memberships lane passes with the demotion path unserialised.

Re-run against `last-owner.integration.spec.ts` alone, three times, same mutation:

```
RUN 1 EXIT=1   Tests  1 failed | 4 passed (5)
RUN 2 EXIT=1   Tests  1 failed | 4 passed (5)
RUN 3 EXIT=0   Tests  5 passed (5)
```

So: **survived 1 of 4 attempts, including the lane shape the report itself used to measure M6.**

The reason is structural. The one deterministic detector —
*a membership write waits for a lock held on the organisation row* — issues a `DELETE`. The two
`Promise.all` tests are the only things that touch the `PATCH` path under contention, and the
report already concedes those are not deterministic. So the role change, which is the case the
**plan** names in its own words ("two concurrent demotions of the two remaining owners must not
both succeed"), is the one with no deterministic guard.

The report's M1 deleted `FOR UPDATE` from the shared `lockOrganization` helper, which the `DELETE`
detector catches. That measures the helper. It does not measure that both callers call it.

**Who it breaks:** the next person to refactor `updateRole`. A dropped `await lockOrganization(...)`
ships green, and the organisation-with-zero-owners anomaly the first test in this very file
measures becomes reachable through `PATCH`.

**The fix shape** (not applied): a second lock-blocking arm that issues the `PATCH`, mirroring the
existing `DELETE` one.

---

## 3. MEDIUM — "nothing can mint a session pointed here afterwards" is false, measured

`membership.service.ts:586-593` claims:

> Nothing can mint a replacement session pointed here afterwards: `Session.activeOrganizationId` is
> written by `POST /auth/switch-org` and by nothing else, and that endpoint decides membership with
> the guard's own resolver — which reads `deletedAt: null`. [...] That is what closes the residual
> `session.service.ts` names against this task ("Task 14 owns the equivalent"): there is no path
> that issues a session already pointed at an organisation the caller has just been removed from.

`.claude/product/permissions.md` invariant 5 now says the same thing in the same words.

**It is ruling 82's shape exactly, and the reasoning is the one ruling 82 struck down.**
`OrganizationSwitchService.switch` reads membership, then calls `SessionService.rotate`, which
**inserts a new `Session` row** carrying `activeOrganizationId`. `revokeAllForUserInOrganization`
is one `updateMany` whose predicate is evaluated at execution time — it cannot revoke a row that
does not exist yet.

### 3.1 The measurement

A 2-second delay was inserted in `organization-switch.service.ts` between the membership read and
`rotate`, and a scratch integration spec arranged the interleaving: Bob (a member, session pointed
at **no** organisation, so the revocation predicate cannot match it) starts a switch into the
organisation; 500 ms later Alice removes him.

```json
{
  "switchStatus": 200,
  "removalStatus": 204,
  "membershipRow": { "status": "REMOVED", "deletedAt": "2026-09-03T05:42:58.250Z" },
  "liveSessionsPointedAtOrg": [
    { "id": "ses_01M1JWNED1E08RSNDZ5QXQPC4Q",
      "activeOrganizationId": "org_01M1JWNCCWFKV93DQ5K18Z2ABC",
      "revokedAt": null }
  ]
}
```

A live, `ACTIVE`, un-revoked session pointed at the organisation Bob was removed from, after the
removal committed and after the revocation ran. The claim is false.

### 3.2 How far that session gets

```json
{
  "authSession": { "status": 200, "body": {
      "activeOrganization": { "id": "org_...", "slug": "race-...", "name": "Race ..." },
      "permissions": [] } },
  "membersList": { "status": 404, "body": { "error": { "code": "RESOURCE_NOT_FOUND" } } },
  "orgRead":     { "status": 404, "body": { "error": { "code": "RESOURCE_NOT_FOUND" } } }
}
```

**No tenant data escapes** — `TenantContextGuard` re-reads the membership with `deletedAt: null`
and answers 404 on every guarded route, which is the compensating layer the docblock correctly
identifies. What survives is smaller but real:

- `permissions.md` invariant 5 — "removing a member revokes their sessions for that organisation
  immediately" — is false for this session.
- `GET /auth/session` serves the organisation's `id`, `slug` and `name` to a non-member.
  `active-organization.store.ts` justifies skipping tenant resolution on the grounds that the id
  "comes from `Session.activeOrganizationId`, a column only this application writes" and that
  "nothing widens". This race is what widens it.
- The removed member's UI shows them inside the organisation with an empty permission set and every
  request 404ing — a stuck state with no route out except switching or signing out.

### 3.3 The part that makes this Medium rather than Low

`session.service.ts` was **not modified by this task** (`git diff --name-only 01dfe99..HEAD | grep
-c session.service.ts` → `0`), so line 711 still reads:

> **Any future caller of this method that needs "and nothing survives" must pair it with an
> equivalent check on whatever path issues sessions** — Task 14's member removal is the next one,
> and its equivalent does not exist yet.

Two files in the same tree now contradict each other about whether this residual is closed, and the
one that says it is closed is the one a reader reaches from the endpoint. Carry-forward ruling 107:
a security property asserted in prose is a hypothesis until someone tries to violate it. Nobody
tried; the report's §7 residual list does not name it.

**The honest correction costs nothing**: state that the removal's authority check is re-read per
request rather than carried in the session, so the surviving session is powerless — which is true,
provable, and is the actual argument. What is false is "there is no path that issues" one.

---

## 4. MEDIUM — `audit.actions.ts` invents a miscount that never happened

Written in commit `1f2239e`, in the comment whose whole subject is ruling 108:

> The counts, computed rather than remembered [...] **The sentence above said "all three" of a
> constant holding two**, and before Task 13's review said "all four" of one holding three.

Measured at the branch base `01dfe99`:

```
git show 01dfe99:apps/api/src/modules/audit/audit.actions.ts | grep -nE "^  '[A-Z_]+',"
41:  'ORGANIZATION_CREATED',
47:  'ORGANIZATION_UPDATED',
96:  'ORGANIZATION_SWITCHED',          → AUDIT_ACTIONS held THREE

git show 01dfe99:.../audit.actions.ts | grep -n "AUDIT_RESOURCE_TYPES = "
119:export const AUDIT_RESOURCE_TYPES = ['Organization'] as const;   → held ONE
```

And the sentence it is describing, at `01dfe99`: *"All three actions above are events about an
`Organization`"* — a correct count of a constant holding three. No constant held two. The second
clause ("'all four' of one holding three") is right; the first is invented.

**`.claude/security/audit.md`, written in the same commit, gets it right** and contradicts the code:

> this paragraph said "three" before Task 14 and "four" before Task 13's review, and **only the
> second of those was ever wrong** about the file as it then stood.

This is Task 13's exact pattern — a correction that introduces a new false claim — landing on
ruling 108's own comment. The counts the comment actually states are correct (verified:
`AUDIT_ACTIONS` 5, `AUDIT_RESOURCE_TYPES` 2, by the very command `security/audit.md` publishes).
What is wrong is the history.

---

## 5. MEDIUM — the report's "34/34 passing" is 36

Report §3.1, on the M6 survivor:

> `pnpm vitest run --project integration apps/api/src/modules/memberships` exits **0**, 34/34
> passing.

Run, unmutated and again under M6:

```
EXIT=0
Test Files  2 passed (2)
      Tests  36 passed (36)
```

**36, not 34**, both times. The report's own arithmetic elsewhere implies 36: it records the
integration lane growing by 36 tests (443 → 479) across the two new files, and those two files are
the whole of this lane.

The substance of §3.1 is sound — M6 does survive, re-measured, exit 0 — and the reasoning for why
(the CHECK constraint makes the two predicates select the same rows) is correct. It is the count
that is wrong, which is precisely ruling 108's subject and precisely the defect class this review
was chartered to find.

---

## 6. LOW findings

**L1 — two stale line citations in report §5.2.** The report offers a list of "genuinely
Phase-2-Task-14 references" as a grep aid, warning that "a cross-phase task-number collision is a
trap for whoever greps next". Two entries do not resolve in the tree the report describes:

| Cited | At `7ef117b` and `HEAD` | Where the Task 14 references actually are |
|---|---|---|
| `product/permissions.md:104` | blank line | 95, 126, 134, 148 |
| `security/authorization.md:262` | "The frontend receives the effective permission set…" | 109, 181, 183, 277, 286, 292, 302 |

Both **were** correct at `01dfe99` and were moved by this task's own documentation commit
`7ef117b`. Everything else in the list verified exact: `session.service.ts` 695/711/736,
`session.repository.ts:121`, `tenant-resolver.store.ts` 30/86, `security/authentication.md:537`,
`tenant-scope.ts:118`, and `git log -S 'Task 14 is carrying a guard'` → `d282998`, 2026-08-20.

**L2 — `authorization.integration.spec.ts` cited without its directory.** It is at
`apps/api/src/modules/roles/`, not `apps/api/src/common/` where a reader following the report's
neighbouring paths would look. Lines 340 and 445 are correct.

**L3 — the organisation row lock is taken before the membership is resolved.** `updateRole` and
`remove` both call `lockOrganization` as the first statement and `liveMembership` second, so a
request naming a membership id that does not exist still takes and holds `FOR UPDATE` on the tenant
row for the length of the transaction. A caller holding `organization.manage_roles` or
`organization.manage_members` can serialise every membership write in the tenant by hammering
non-existent ids. Privileged-only, and each lock is short. Noted, not pressed — the ordering is
also what makes the lock unconditional, which is the property D1 wanted.

**L4 — one `Membership` statement in the file does not carry the predicate the docblock says they
all carry.** `assertOrganizationKeepsAnOwner`'s docblock: *"every other `Membership` read in this
file carries it (ruling 99)"*. `updateRole`'s write does not:

```ts
const updated = await tx.membership.update({
  where: { id: membershipId },        // no deletedAt, no organizationId
  data: { roleId: granted.id },
```

Not a live defect: the row was resolved live by `liveMembership` inside the same lock, RLS scopes
it, and no other writer can reach it without that lock. The removal path's `updateMany` states both
predicates. This is the inconsistency, not the risk.

**L5 — no arm covers a removal racing a demotion.** The suite has demotion × demotion and removal ×
removal. The mixed case is covered by construction because both paths share `lockOrganization` —
and §2 above is the measurement showing that "they share the helper" is exactly the assumption a
per-path regression breaks.

---

## 7. The two open questions the implementer flagged

### 7.1 An `ADMIN` holding `organization.manage_members` can remove an `OWNER` — **a defect, and it should be decided rather than shipped silently**

Not a privilege escalation: the `ADMIN` gains nothing they did not hold, and the last-owner
invariant guarantees one `OWNER` survives (verified — `assertOrganizationKeepsAnOwner` fires on
`remove` with `isOwnerAfter: false`, and the 422 arm is tested).

But `security/authorization.md` §4's principle is "you cannot mint authority you do not possess",
and D5 now enforces its positive half on `PATCH` while its mirror is unenforced on `DELETE`. The
asymmetry has a sharp edge: **an `ADMIN` cannot make an `OWNER`, but can unmake one, and cannot
undo it.** They can evict every owner but one — including the person who created the organisation —
and each eviction revokes that owner's sessions for the tenant. An action a principal can perform
but cannot reverse from within their own authority is the kind that wants a rule, not a note.

The implementer was right to refuse to invent the rule inside the task; the brief did not give it.
It is now the orchestrator's to decide, and it should be decided before Task 15 adds invitations,
because "who may remove whom" and "who may invite whom" are one question.

### 7.2 Self-removal is permitted — **not a defect**

Leaving an organisation is a legitimate action; the last-owner invariant prevents the only
dangerous case (the sole owner walking out, which answers 422); and the same call revokes the
leaver's sessions for that tenant, which is the correct end state. Ruling 95 is satisfied — their
sessions elsewhere and their account survive.

The one gap is documentation. Neither the OpenAPI description nor any `.claude` document says
self-removal is supported, so a client cannot tell whether `DELETE .../members/{ownMembershipId}`
is a feature or an accident. One sentence in the route description, not a code change.

---

## 8. What I checked and found sound

So the green here is legible, this is what was verified rather than assumed.

**Counts recomputed** (ruling 108 — every one of these was run, not read):

| Claim | Measured |
|---|---|
| `pnpm test` 98 files / 1668 tests, exit 0 | ✅ exact |
| `check:specs` 125 | ✅ exact |
| `check:openapi` exit 0, `"routes":24`, 24 paths / 28 operations | ✅ exact, counted from `openapi.json` |
| `check:registry` 15 models, 3 tenant-owned, 1 root, 11 global | ✅ exact |
| `check:secrets` 445 tracked files | ✅ exact |
| `git diff --stat 01dfe99..7ef117b` = 26 files, 3966 ins, 101 del | ✅ exact |
| All eleven created-file line counts (629/260/52/35/138/204/883/419/104/71/85) | ✅ all eleven exact |
| `AUDIT_ACTIONS` 5 names, `AUDIT_RESOURCE_TYPES` 2 | ✅ by `security/audit.md`'s own published command |
| "Seven shipped routes declare a permission" | ✅ 7 in `EXPECTED_GUARDED_ROUTES` |
| `backend.md`'s per-module controller/service/repository counts | ✅ all six modules exact |
| 49 ordered role pairs | ✅ `ROLE_PERMISSIONS` has 7 keys |
| Report §5.5's `check:secrets` correction of the brief | ✅ independently reproduced: `origin/main` **434**, base 434, HEAD 445; `git diff --name-only origin/main 01dfe99` returns two files, both under `docs/superpowers/` and both excluded by the script's own `EXCLUDED_PATHS`. The brief's "433 measured on main" was wrong and the report is right to say so |
| Brief's `session.service.ts:739` | ✅ `async revokeAllForUserInOrganization` |

**Mutations re-run by this review** (the report lists fourteen; three were re-measured, plus one
new one):

| # | Result |
|---|---|
| M1 — delete `FOR UPDATE` | ✅ **red**, exit 1, exactly the 3 tests the report names |
| M6 — delete `deletedAt: null` from the owner count | ✅ **survives**, exit 0 — the report's substance confirmed, its count corrected (§5) |
| *new* — lock removed from `updateRole` only | ❌ **survives** — §2 |
| *new* — Bob starts 500 ms late in the unlocked race test | ❌ **red deterministically** — §1 |

M2, M3, M4, M5, M7, M8, M9, M10, M11, M11b, M12, M13 and M14 were **not** re-run. Their targets
were read and the tests they name were opened and confirmed to assert what is claimed, but this
review has not independently measured them.

**Cross-tenant isolation — sound.** Every arm answers 404, never 403, and the arms are real:

- another tenant's `membershipId` on `PATCH` and on `DELETE`, each asserting the target row is
  `ACTIVE` / `deletedAt: null` afterwards, so the 404 is a refusal and not a silent success;
- a *real, live* membership in the caller's own organisation reached through a path naming a
  different organisation, on all three routes — the arms `81d7574` added, and the ones that make
  `assertPathIsActiveTenant` load-bearing per route rather than only through the matrix (report
  §3.3's own finding, and it is a good one);
- a `membershipId` that does not exist, with the same body;
- a membership already removed.

The cursor cannot cross a tenant: it carries only `(createdAt, id)` into a query already predicated
on `organizationId` and `deletedAt: null`. The `roleKey` body is a `z.enum`, so the role change
body carries nothing tenant-shaped.

**Soft delete (rulings 99 and 100) — sound.** `list`, `liveMembership` and the owner count all
carry `deletedAt: null`, and the removal's `updateMany` carries it too. The round-trip regression is
genuinely **arranged to lose**: two remove/re-add cycles, then a physical assertion that three rows
exist with two `REMOVED` written *before* the live one, and only then a real guarded request as the
re-added member. That is ruling 100 done properly — unlike §1's race test, which is the same file's
counter-example.

**Audit (rule 10) — sound, structurally.** `AuditService` has **no constructor and no Prisma
client**; `record(tx, ...)` writes through the caller's handle, and both call sites are inside
`withTenantTransaction`. The change cannot commit without the event and the event cannot commit
without the change — enforced by the shape of the dependency, not by convention.

**D5 — sound, and better than the brief asked.** A set comparison, not a ranking. 49 ordered pairs
with the expectation derived from `ROLE_PERMISSIONS` rather than transcribed, plus a non-vacuity arm
(ruling 58). The one thing that looked like a fail-open — `assertActorMayGrant` silently ignoring a
granted key outside `PERMISSIONS` — is **symmetric and therefore correct**: `knownPermissions`
(`tenant-context.ts:139`) filters `ctx.permissions` the same way at
`tenant-resolver.store.ts:144`, so the two sides of the comparison cannot disagree about which keys
exist. The spec says so and gives the reasoning.

**The owner count — sound.** It excludes the subject row, so one statement yields both the before
and the after count; `status: 'ACTIVE'` correctly excludes an `INVITED` owner (tested, and it is
the predicate the CHECK constraint does *not* imply); and it refuses only when the write is what
breaks the invariant, so an organisation that somehow already has no live owner is not made
unrecoverable.

**Authorization matrix — sound.** `crossTenantProbeFor` is a per-route registry with a throwing
default, which is ruling 109's fix shape rather than a generator that can silently guess. `bodyFor`
carries the membership `PATCH` (ruling 110). `:membershipId` substitutes the **actor's own** row so
arm 4 can reach a real 200 instead of a 404 that looks like arm 3's. `require-mfa.spec.ts` names the
three declaring controller files rather than counting them, and strips comments first so
`auth.controller.ts`'s prose mentions of `@RequirePermission()` do not false-positive.

**Contracts docblock — sound.** The correction is accurate (no shipped route ever read memberships
before this task), the narrow projection is unchanged, and the reasoning is recorded so it is not
re-opened.

**Not verifiable, and not counted as a finding:** report §3.4's pre-implementation baseline
("25 failed / 8 passed"). No commit in the range holds the spec files without the handlers, so the
claim cannot be reproduced from history. Recorded so a later reader does not mistake its absence
here for confirmation.

---

## 9. Recommendation

**Do not merge as-is.** Two things must move before this is green:

1. **§1** — the lane goes red about half the time. Fix the barrier (a two-party gate: Alice must
   wait for Bob's count as well as the reverse), or the branch fails CI intermittently on its own
   headline evidence.
2. **§3** — either close the residual or stop claiming it is closed. The claim appears in shipped
   source *and* in `.claude/product/permissions.md`, and `session.service.ts:711` says the opposite
   three files away.

**§2** should move with them: a `PATCH`-issuing arm of the lock-blocking test is a dozen lines and
is the difference between the demotion race being tested and being asserted.

**§4 and §5** are corrections to prose, and **§7.1** is a decision the orchestrator now owns.

The code itself is good. The isolation, the soft-delete handling, the audit wiring, the D5 set
comparison and the round-trip regression are all better than the bar. What this review found is
what this project keeps finding: the sentences around the code are less reliable than the code.
