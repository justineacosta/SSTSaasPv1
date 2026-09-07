# Task 15 / D9 — Adversarial review

**Reviewer:** fresh adversarial reviewer (did not write this code)
**Branch:** `feat/phase-2-task-15-d9-invitation-revocation`
**Baseline diff:** `git diff 53f40aa..HEAD`
**Started:** session start, document created before any reading (carry-forward ruling 131)

## Status

- [ ] Read brief, ADR-0026, d9-brief, d9-report
- [ ] Read diff
- [ ] Code pass (concurrency, RLS, cross-tenant, rollback)
- [ ] Citation pass (report claims, code comments, ADR-0026, `.claude/` edits)
- [ ] Final judgement

## Findings

_(appended as they land)_

## What I could NOT verify

_(appended as they land)_

## Overall judgement

_(pending)_

---

## Finding 1 — MEDIUM (citation pass) — `d9-report.md` claims a grep it did not perform, and the citation it claims to have fixed is still broken

**What is wrong.** `d9-report.md`, §"Documentation changed in the same change", states of
`invitation.service.ts`:

> It now says CLOSED, cites both new tests **by their exact names** (ruling 129; I grepped for my
> own citations afterwards and both resolve)

Both halves are false. The citation at `apps/api/src/modules/invitations/invitation.service.ts:734`
reads `an invitation does NOT outlive its issuer's authority` with a **straight** apostrophe
(U+0027). The test it names, at `invitations.integration.spec.ts:1777`, is
`an invitation does NOT outlive its issuer’s authority` with a **curly** apostrophe (U+2019). A
grep for the cited string finds nothing.

**How I established it** (from the repository root):

```
$ grep -rn "an invitation does NOT outlive its issuer's" apps/api/src --include=*.spec.ts
exit=1        # no match

$ grep -rn "an invitation does NOT outlive its issuer’s" apps/api/src --include=*.spec.ts
apps/api/src/modules/invitations/invitations.integration.spec.ts:1777:  it('D9 — CLOSED BY ADR-0026: an invitation does NOT outlive its issuer’s authority', ...
apps/api/src/modules/memberships/memberships.integration.spec.ts:1051: * `D9 — CLOSED BY ADR-0026: ... issuer’s authority`,
```

The *other* citation in that same comment block —
`the invitation cascade on a membership write (ADR-0026)` — does resolve
(`memberships.integration.spec.ts:1061`). So one of the two resolves, not "both".

**This is a regression the change had the chance to fix and instead reasserted.** The baseline had
exactly the same mismatch:

```
$ git show 53f40aa:apps/api/src/modules/invitations/invitation.service.ts | grep -n "RECORDS AN OPEN WINDOW" -A1
653:   *    by `D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's
$ git show 53f40aa:apps/api/src/modules/invitations/invitations.integration.spec.ts | grep -n "RECORDS AN OPEN WINDOW"
1773:  it('D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer’s authority', ...
```

and the *replacement* comment says, in the same breath, "because the first version of this line
paraphrased its test and a grep for the citation found nothing (ruling 129)". The line was rewritten
to fix a ruling-129 defect and reintroduced it.

**Two other copies of the same break, outside the code:**
- `.claude/product/roadmap.md:2435` cites the new name with a straight apostrophe — broken.
- `.claude/product/roadmap.md:2420` and `ADR-0026` line 9 cite the *old* name
  `D9 — RECORDS AN OPEN WINDOW: an invitation outlives its issuer's authority` — straight
  apostrophe, and the test no longer exists under any spelling. Two ways broken.

The correctly-spelled citations are `invitation-revocation.cascade.ts:90` and
`memberships.integration.spec.ts:1051` (both curly).

**Cost if left.** Directly the cost ruling 129 was written for: a future reader or agent greps the
cited name, finds nothing, and concludes the guarantee is unpinned — which is how the previous
paraphrase defect was found in the first place. Worse, the report asserts a verification that was
not done, which is Phase 1's single recurring defect class reappearing inside the document written
to prevent it.

## Finding 2 — LOW (citation pass, ruling 108) — the moved `LIVE_INVITATION` docblock states a count that is wrong under the reading its own words invite

**What is wrong.** `invitation-revocation.cascade.ts:16` says the constant exists "rather than
**four** inline object literals". The baseline said "three". There are **7** spread sites, not four:

```
$ grep -rn "\.\.\.LIVE_INVITATION" apps/api/src | wc -l
7
```
(`invitation-revocation.cascade.ts` 152, 176; `invitation.service.ts` 375, 381, 593, 599, 833.)
At baseline there were **5**, and the docblock said "three" — so the sentence was already wrong and
the edit that touched it (three → four) did not compute the count either.

**In fairness:** four *methods* touch it (`create`'s supersession, `revoke`, `accept`, the cascade),
and three did at baseline, so the numbers are right under a "call site = method" reading. The words
chosen are "inline object literals", and there would be seven of those. I am recording it as a Low
rather than a Medium because the intent is recoverable, but ruling 108 says compute the count and
the count as written does not check out.

**How I established it.** The two greps above, plus
`git show 53f40aa:apps/api/src/modules/invitations/invitation.service.ts | grep -c "\.\.\.LIVE_INVITATION"` → `5`.

**Cost if left.** Small: a reader who greps to find "the four places" finds seven and does not know
which three they are not looking at. It matters mostly as evidence that the count was copied and
incremented rather than measured.

## Finding 3 — LOW (citation pass) — `memberships.tokens.ts` states there is "no runtime edge from `memberships/` into `invitations/` at all", and there is one

**What is wrong.** `memberships.tokens.ts` (docblock on `INVITATION_REVOCATION_CASCADE`) says:

> `membership.service.ts` takes the type with `import type`, which TypeScript erases, so there is
> **no runtime edge from `memberships/` into `invitations/` at all**.

The premise is right and the conclusion overreaches by one file.
`apps/api/src/modules/memberships/memberships.module.ts:6-9` imports `invitationRevocationCascade`
— a **value** — from `../invitations/invitation-revocation.cascade.js`. That is a runtime edge from
`memberships/` into `invitations/`.

**How I established it.**
```
$ grep -rn "from '../invitations/" apps/api/src/modules/memberships/
memberships.module.ts:6:} from '../invitations/invitation-revocation.cascade.js';      # value import
membership.service.ts:18:import type { InvitationRevocationCascade } from '../invitations/invitation-revocation.cascade.js';   # type-only
memberships.integration.spec.ts:21:import type { InvitationRevocationCascade } ...        # type-only
```

`d9-report.md` states the same claim but correctly qualified ("the only runtime import in that
direction is in `memberships.module.ts`, which nothing in `invitations/` imports"). The code comment
is the copy that dropped the qualifier, and the code comment is the one a future reader will find.

**Cost if left.** A reader who believes the absolute statement will not look for the module-level
edge when reasoning about a future cycle, and the acyclicity argument in this change rests entirely
on which direction the edges point. The claim it should make is the true and still-sufficient one:
the only runtime edge is `memberships.module.ts` → `invitation-revocation.cascade.ts`, and nothing
in `invitations/` imports `memberships.module.ts`.

## Finding 4 — HIGH (code pass) — ADR-0026 §3's race is NOT closed. I reproduced the original D9 escalation end to end, through the real routes, on this branch

**What is wrong.** ADR-0026 §3 and `d9-brief.md` item 3 both assert that re-reading the actor's
membership inside `create`'s transaction closes the in-flight window:

> ADR-0026 §3: "…so a `create` already in flight when the removal commits cannot slip past the
> cascade… it is closed here rather than recorded as owed, because a cascade that a concurrent
> request can walk around is not a control."

It can still be walked around. The re-read makes `create` decide on the database's state rather than
the guard's, but **it does not serialise `create` against `remove`/`updateRole`**, and it does not
change the isolation level. Under READ COMMITTED a `create` whose re-read runs *before* the removal
commits sees a live membership, is allowed, and inserts its row *after* the cascade's `findMany` has
already looked. The cascade cannot revoke a row that did not exist when it ran — which is the exact
sentence ADR-0026 uses to justify the fix, and it remains true of the fix.

**How I established it — measured, on this branch, through the real endpoints.**

I temporarily inserted an env-gated `setTimeout` into `invitation-revocation.cascade.ts` immediately
after its `findMany`, still inside the caller's transaction, to widen the window to something a test
can hit. Then, in a temporary block appended to `invitations.integration.spec.ts`, I fired
`DELETE /api/v1/organizations/:id/members/:membershipId` (real route, real guard chain), waited
1200 ms, and fired `POST /api/v1/organizations/:id/invitations` as the member being removed (real
route, real guard chain, `roleKey: OWNER`).

```
$ npx vitest run --project integration --no-file-parallelism \
    -t "PROBE: a create in flight" \
    apps/api/src/modules/invitations/invitations.integration.spec.ts
EXIT=0
PROBE removal status 204 {}
PROBE invite status 201 {"id":"inv_01M1YC93WN…","roleKey":"OWNER","revokedAt":null,…}
PROBE invitation row {"id":"inv_01M1YC93WN…","revokedAt":null,"acceptedAt":null,…}
PROBE issuer membership after {"deletedAt":"2026-09-07T16:47:30.497Z","status":"REMOVED"}
PROBE accept status 201 {"…","roleKey":"OWNER","status":"ACTIVE",…}
PROBE VERDICT RACE OPEN: live OWNER invitation from a removed member
```

The last line is the whole point: **the invitation was then redeemed and minted an `OWNER`
membership** in that organisation, issued by a user whose membership row reads
`status: REMOVED, deletedAt: <set>`. That is byte for byte the outcome the deleted test
`D9 — RECORDS AN OPEN WINDOW…` used to pin, reproduced on the branch that claims to have closed it.

The demotion arm is the same:

```
$ npx vitest run --project integration --no-file-parallelism -t "PROBE2" …
PROBE2 demotion status 200
PROBE2 invite status 201 {"…","roleKey":"OWNER","revokedAt":null,…}
PROBE2 issuer role after MEMBER invitation {"…","revokedAt":null}
PROBE2 VERDICT RACE OPEN: live OWNER invitation from a member demoted to MEMBER
```

**Why it is open, established by inspection to explain the measurement (not to replace it):**

1. `packages/db/src/tenant-transaction.ts` calls `scoped.$transaction(fn)` with **no**
   `isolationLevel`. `grep -rn "isolationLevel" apps packages --include=*.ts` finds no application
   call site — only Prisma's generated types. So every transaction here is Postgres' default
   READ COMMITTED, under which a non-locking `SELECT` reads the last committed row version and does
   not block on another transaction's uncommitted `UPDATE`.
2. `InvitationService.create` **does not take the organisation lock.**
   `grep -rn "lockOrganization" apps/api/src --include=*.ts | grep -v spec` gives exactly three call
   sites: `invitation.service.ts:765` (that is `accept`), `membership.service.ts:517` (`updateRole`),
   `membership.service.ts:651` (`remove`). `create` takes only
   `pg_advisory_xact_lock(hashtext('inv:<org>:<email>'))` (`invitation.service.ts:172`), a different
   key, so it contends with nothing the two membership writes hold.
3. `actorAuthority` uses `tx.membership.findFirst` — a plain read, not `FOR UPDATE` — so it acquires
   nothing that would make it wait for the removal.

**On the artificial delay.** The probe widens the window; it does not create it. The window is
`create`'s re-read → `create`'s commit overlapping `remove`'s cascade-read → `remove`'s commit, and
its natural width is the duration of two ordinary transactions on the same tenant. Points 1–3 are
what make it exist at all, and none of them is affected by the delay. I did not attempt to measure
how often it reproduces without the delay, and I am not claiming it is easy to hit unaided.

**The repository already knows the remedy and wrote it down.** `lockOrganization`'s docblock
(`membership.service.ts:102-176`) says: *"Every membership write that can change the owner count
takes it… A writer that skips it is outside the serialisation and reopens the race for everyone"*,
and records that `SERIALIZABLE` was considered and rejected in favour of the lock. `create` is now,
by ADR-0026, a writer whose correctness depends on that same serialisation, and it is outside it.
`lockOrganization` is exported and `invitation.service.ts` already imports it (line 25) for `accept`.
I have not measured whether adding it to `create` closes the probe, because the brief forbids me
changing code — but that is the shape of the fix, and it costs one lock on a path that already
takes one.

**Cost if left alone.** The highest-value open security item in Phase 2 is recorded as closed while
a re-escalation path for a just-removed `OWNER` remains open, reachable by that person timing one
request against their own removal — which is precisely the person motivated to try, and the removal
is an event they can observe (their session dies). Every downstream document now says the window is
shut: `.claude/security/authentication.md` deleted its open-window paragraph, `roadmap.md` moved the
item to closed, and the test named to warn about it was rewritten. A future reader has nothing left
telling them to look.

**A narrower, honest claim the change is entitled to make.** The re-read *does* work, and my probe
confirms the mechanism: a `create` whose re-read runs *after* the removal commits is refused (that
is what the implementer's two direct-service tests show, and they are sound). What is not true is
that the window is closed. ADR-0026 §3's final sentence, `d9-brief.md` item 3, the
`invitation.service.ts:290-317` docblock and `d9-review-brief.md`'s opening paragraph all overstate
it in the same words, and all four need correcting whether or not the lock is added.

**Working tree restored.** `git checkout apps/api/src/modules/invitations/invitation-revocation.cascade.ts apps/api/src/modules/invitations/invitations.integration.spec.ts` — confirmed clean with
`git status --short` (only this review document is modified).

## Finding 5 — MEDIUM (citation/documentation pass) — `roadmap.md`'s status section still asserts the defect in the present tense, in bold, above the correction

**What is wrong.** `.claude/product/roadmap.md:2402` retitles the section
`### The window that was open — CLOSED by ADR-0026, and the record of how`, and then leaves the
entire original body unedited beneath it, in the present tense:

- 2404: "**An invitation offering `OWNER` survives its issuer being removed, and accepting it still
  mints an `OWNER`.**" — bold, present tense, first line of the section.
- 2406-2407: "the removed owner's invitation **is** still live and the acceptor **receives** 201".
- 2409: "This **is** a re-escalation path…"
- 2413-2415: "**The remedy is on the other side of the transaction** … it **is recorded as owed
  rather than taken here**."

"**It is closed.**" appears at 2423, four paragraphs and twenty lines later. Only the pinned-test
sentence at 2420 was moved into the past tense.

**How I established it.** `sed -n '2400,2442p' .claude/product/roadmap.md`, read in full. The diff
(`git diff 53f40aa..HEAD -- .claude/product/roadmap.md`) confirms the only edits to that section are
the heading, three tense fixes on the pinned-test sentence, and the two appended paragraphs.

**Why this is not pedantry.** `CLAUDE.md` names `roadmap.md` as "the single source of truth for
status", read by a resuming session before anything else, and the failure mode it names is a
resuming session that "rebuild[s] what exists or skip[s] what does not". This section now reads, to
anything that greps or skims, as a live security defect whose remedy is recorded as owed. The right
shape is the one the "Still owed after Task 15" bullet twenty lines further down actually uses —
strike the old claim through, state the new one.

**Cost if left.** A future session reads 2404 and either rebuilds the cascade or believes the
platform is exposed when the same file tells it otherwise. Given Finding 4 the stale paragraph is
accidentally closer to the truth than the correction is, which is a defence of neither.

## Finding 6 — MEDIUM (documentation rule) — `.claude/security/audit.md` was not updated, and it is the file that enumerates producers and metadata keys

**What is wrong.** This change gives `INVITATION_REVOKED` a second producer and two new metadata
keys (`reason`, `issuerUserId`), and makes a removal write a non-constant number of audit rows.
`.claude/security/audit.md` is untouched:

    $ git diff --stat 53f40aa..HEAD -- .claude/security/
     .claude/security/authentication.md | 20 +++++++++++---------

That file's §4 is where this repository records exactly this kind of change, with a consistent
convention — "`ORGANIZATION_SWITCHED` was added to this list by Phase 2 Task 13, in the same change
as the endpoint that writes it"; "`MEMBER_REMOVED` and `ROLE_CHANGED` gained producers in Phase 2
Task 14, in the same change as the two handlers that write them… Both carry `before`, `after` and
`memberUserId` in `metadata`"; "**Three of that group gained producers in Phase 2 Task 15**".
ADR-0026's producer is the first in that section's history not to get its paragraph.

Nothing in `audit.md` is now *false* — I read §2, §4 and §5 and the existing sentences survive — so
this is an omission rather than a contradiction, which is why it is Medium and not High.
`CLAUDE.md`'s documentation rule ("When you change … a security control, update the matching
`.claude/` document **in the same change**") names the security docs, and `audit.md` is the matching
one for an audit-action change. `d9-report.md` does not claim `audit.md` was updated, so the report
is honest here; the defect is the omission.

**On §5 specifically, which the review brief asked about: I found nothing forbidden.** The cascade's
`metadata` is `{ email, roleKey, reason, issuerUserId }`. `email` and `roleKey` are what the
deliberate `revoke` at `invitation.service.ts:608` already writes and what `audit.md` §4 already
documents for this action; `reason` is an enum literal; `issuerUserId` is an id. The cascade's
`select` reads only `id`, `email` and role keys — `tokenHash` is never loaded, so it cannot reach an
event. Established by reading `invitation-revocation.cascade.ts:148-206` against
`.claude/security/audit.md:281-286`.

**Cost if left.** The next person auditing "what writes `INVITATION_REVOKED`" reads `audit.md` §4,
finds one producer, and builds a query or an alert on a false cardinality assumption — the exact
consequence ADR-0026's own "Neutral" paragraph flags.

## Finding 7 — LOW (citation pass, ruling 128) — mutation 3's recorded reason names the wrong layer

**What is wrong.** `d9-report.md`'s mutation table explains why dropping `organizationId` from the
cascade's read predicate stays green:

> `Invitation` carries `FORCE ROW LEVEL SECURITY` keyed on `organizationId` and every statement runs
> inside `withTenantTransaction`, so RLS refuses the other tenant's rows whether or not the
> predicate names them.

RLS is the *second* thing that stops it. The first is layer 1: the tenant-scoping Prisma extension
injects the predicate back in before the query is issued, so the mutated statement never reaches
Postgres without `organizationId` at all.

**How I established it.**

    $ grep -n "TENANT_OWNED_MODELS" packages/db/src/tenant-resources.ts
    12:export const TENANT_OWNED_MODELS = ['Membership', 'Invitation', 'AuditEvent'] as const;

    $ grep -n "findMany\|updateMany" packages/db/src/tenant-scope.ts
    27:  'findMany',
    35:const SCOPED_WHERE_AND_DATA_MANY_OPERATIONS = new Set(['updateMany', 'updateManyAndReturn']);

`Invitation` is a tenant-owned model and both operations the cascade uses are scoped operations, so
`createTenantClient`'s `$allOperations` hook rewrites the `where` (`packages/db/src/tenant-client.ts`,
`decideScope` → `case 'run'`).

Ruling 128 says a mutation that cannot go red is a claim about the system and the claim must be
written down; the claim as written is about the wrong layer. **The code comment gets it right** —
`invitation-revocation.cascade.ts:143-147` says "the tenant-scoping extension would inject it *and*
RLS would refuse another tenant's row anyway" — so this is a defect in the report only.

**I independently confirmed the mutation does survive**, which the report is right about:

    $ # organizationId removed from the cascade's findMany where
    $ npx vitest run --project integration --no-file-parallelism \
        apps/api/src/modules/memberships/memberships.integration.spec.ts
    MUT3 EXIT=0    Tests 42 passed (42)
    $ git checkout apps/api/src/modules/invitations/

**Cost if left.** Someone who later runs this path on an unscoped connection — the platform-admin
module and the seeds already do, per `tenant-client.ts`'s own comments — would reason from the
report that RLS alone has them covered.

## Finding 8 — LOW (test coverage) — self-removal, the consequence ADR-0026 calls its principal cost, has no test

**What is wrong.** `MembershipService.remove`'s docblock (`membership.service.ts:630-636`) says
"**Self-removal is supported**, and it is supported rather than tolerated", and ADR-0026's
"Negative — and this is a real cost, not a rounding error" paragraph is entirely about the member
who leaves benignly taking their invitations with them. Nothing tests it. All seven cascade cases
have the actor act on somebody else:

    $ sed -n '1061,1400p' apps/api/src/modules/memberships/memberships.integration.spec.ts \
        | grep -n "membersPath(organizationId)}/"
    42:  .delete(...leavingMembership)
    96:  .delete(...leavingMembership)
    133: .patch(...demotedMembership)
    169: .patch(...promotedMembership)
    200: .patch(...unchangedMembership)

plus `hereMembership` in the cross-tenant case and the direct-port call in the rollback case. In
every one the subject is a fixture user, never `actor`. The review brief asked this question
directly and `d9-report.md` does not answer it.

**A related smaller thing.** `audit.actions.ts`'s new docblock says of the cascade's `actorId`:
"that person is the one who removed or demoted the issuer, **not the issuer**". On a self-removal
they are the same person, so a reader using that sentence to tell the two producers apart will be
wrong for exactly the case ADR-0026 says will be the common one.

**What I did not do.** I did not write the missing test — the brief forbids changing code. I found
no behavioural bug here by inspection: `remove` passes `command.actorUserId` and `membership.userId`
independently, so self-removal should set both to the same id, and the last-owner invariant refuses
the sole-owner case at 422 before the cascade runs. That is reasoning, not measurement, and I am
labelling it as such.

**Cost if left.** Low. The behaviour is probably right; what is missing is the pin on the one
consequence the ADR says users will notice.

## Finding 9 — MEDIUM (code pass, mutation) — "a SET comparison, never a ranking" is the design's centrepiece, is asserted in four places, and no test distinguishes it. I replaced it with the ranking and everything stayed green

**What is wrong.** ADR-0026 states the rule three times ("The comparison is `assertActorMayGrant`'s
— a set comparison against the seeded `RolePermission` rows, not a ranking — so the rule that
revokes and the rule that refuses cannot drift into two models of authority"), the cascade's
docblock gives it its own heading (`invitation-revocation.cascade.ts:99-110`, "# THE COMPARISON IS A
SET TEST, NEVER A RANKING"), `membership.service.ts:588-590` repeats it, and the demotion test's
comment asserts it: "The comparison is `assertActorMayGrant`'s — a SET comparison against the
seeded `RolePermission` rows, not a ranking."

**No test can tell the two apart.** I replaced the subset filter with the ranking the design
explicitly rejects — a comparison of permission *counts* — and ran both spec files:

    // REVIEW MUTATION 5: a RANKING by permission count, not a set comparison.
    const doomed = retained === null
      ? candidates
      : candidates.filter((candidate) => candidate.role.permissions.length > retained.size);

    $ npx vitest run --project integration --no-file-parallelism \
        apps/api/src/modules/memberships/memberships.integration.spec.ts \
        apps/api/src/modules/invitations/invitations.integration.spec.ts
    MUT5 EXIT=0    Test Files 2 passed (2)    Tests 78 passed (78)
    $ git checkout apps/api/src/modules/invitations/

The reason is that all three role-change cases chosen are on a totally ordered chain:
`OWNER` → `MEMBER` with `OWNER`/`ADMIN`/`MEMBER` invitations, `MEMBER` → `ADMIN`, `ADMIN` → `ADMIN`.
On that chain a ranking and a subset test agree on every row, so the assertion in the test comment
is not something the test checks.

**Unlike mutations 3 and 4, this one is not undistinguishable in principle** — the seeded data
already contains the counterexample:

    $ node -e "...ROLE_PERMISSIONS subset lattice..."
    role sizes: OWNER=49 ADMIN=47 SECURITY_LEAD=33 MEMBER=23 VIEWER=12 AUDITOR=15 GUEST=11
    Incomparable pairs (neither is a subset of the other):
       SECURITY_LEAD <-> AUDITOR
       MEMBER <-> AUDITOR
       VIEWER <-> AUDITOR
       AUDITOR <-> GUEST
    total incomparable pairs: 4
    AUDITOR not-in SECURITY_LEAD: [ 'audit.read', 'billing.read' ]
    AUDITOR subset of ADMIN? true

So one realistic case separates them: **an `ADMIN` issues an `AUDITOR` invitation** (permitted —
`AUDITOR` ⊆ `ADMIN`) **and is then changed to `SECURITY_LEAD`.** `AUDITOR` carries `audit.read` and
`billing.read`, which `SECURITY_LEAD` does not, so the set test revokes it. A count ranking says
15 > 33 is false and keeps it — a live invitation offering two permissions the issuer no longer
holds, which is exactly what ADR-0026 exists to prevent. That case is one `it(...)` in the block
that already exists.

**How I established it.** The mutation run above, plus the lattice computed from
`ROLE_PERMISSIONS` in `packages/contracts/dist/index.js` (ruling 108 — computed, not eyeballed).
I have **not** measured that the real code revokes in the `ADMIN` → `SECURITY_LEAD` scenario; I read
the filter and it should, but no test exercises it and I did not write one (the brief forbids
changing code).

**Cost if left.** The one property the ADR says must never drift is unprotected by the suite. A
later "simplification" to a role rank — which is the shape a reader who has not read the ADR
reaches for, and which several other systems in this repo would make look natural — passes CI
unchanged and silently stops revoking the incomparable cases. Ruling 128 says a mutation that
cannot go red is a claim about the schema that must be written down; this one *can* go red, and the
report does not list it because it was not tried.

## Finding 10 — LOW (code pass) — the audit `reason` says `ISSUER_DEMOTED` for role changes that are not demotions

**What is wrong.** `updateRole` always passes `reason: 'ISSUER_DEMOTED'`
(`membership.service.ts:596`), and `InvitationRevocationReason` offers only `ISSUER_REMOVED` and
`ISSUER_DEMOTED`. Because the rule is a set test and the role lattice is only partially ordered
(Finding 9: four incomparable pairs, all involving `AUDITOR`), a **lateral** change can revoke. A
member moved `MEMBER` → `AUDITOR` loses `MEMBER`'s non-`AUDITOR` permissions and their pending
`MEMBER` invitations are revoked with `reason: ISSUER_DEMOTED`, though `AUDITOR` is not below
`MEMBER` in any sense the codebase defines — `AUDITOR` holds `audit.read` and `billing.read`, which
`MEMBER` does not.

**How I established it.** The lattice computation in Finding 9, plus reading
`membership.service.ts:591-601` and `invitation-revocation.cascade.ts:41-46`.

**Cost if left.** Small and purely forensic: the audit trail uses ranking vocabulary for a rule the
design insists is not a ranking, so an investigator reading `ISSUER_DEMOTED` infers a demotion that
did not happen. `ISSUER_ROLE_CHANGED` would say what actually occurred. Noting it rather than
pressing it — the enum is cheap to widen later and doing so is not free of its own churn.

## Finding 11 — LOW (code pass) — `actorAuthority` re-reads two of the four facts the guard decided, and the report names only one of the two it skips

**What is wrong.** The review brief asked: "What else does the guard decide that the transaction
does not re-check?" `resolveTenant` (`apps/api/src/common/guards/tenant-context.ts:115-136`) decides
four things: an active organisation is selected; the membership exists **and is `ACTIVE`**; the
**organisation is not suspended**; and the role/permissions. `actorAuthority`
(`invitation.service.ts:203-220`) re-reads the membership row and its permissions. It does not
re-read:

1. **The route's own `organization.manage_members`.** `d9-report.md` residual risk 1 names this, and
   the test `decides on the role the database holds, not the role the context claims` pins it as
   current behaviour: a stale `OWNER` context whose row now says `MEMBER` is still allowed to create
   a `MEMBER` invitation, and `MEMBER` does not hold `organization.manage_members`. Correctly
   disclosed.
2. **The organisation's suspension state.** Not named anywhere. `assertPathIsActiveTenant` is only
   `if (pathId !== ctx.organizationId) throw notFound()`
   (`organizations/organization.service.ts:76-78`) — it reads no row. So an in-flight `create` while
   the organisation is being suspended is in the same position as item 1. Same window as Finding 4,
   same size, and the guard would refuse the next request.
3. **`status === 'ACTIVE'`.** `resolveTenant` refuses a membership that is `INVITED` *or* `REMOVED`,
   and its docblock makes a point of it. `actorAuthority` filters only on `deletedAt: null`, and the
   `Membership_status_deletedAt_agree_check` biconditional ties `deletedAt` to `REMOVED` only — an
   `INVITED` row has `deletedAt IS NULL` and would resolve here, granting its role's permissions.
   **Unreachable today**, because nothing writes `'INVITED'`:

       $ grep -rn "'INVITED'" apps/api/src packages/db --include=*.ts | grep -v spec
       apps/api/src/modules/invitations/invitations.controller.ts:73,74   (a comment saying exactly this)
       apps/api/src/modules/memberships/membership.service.ts:215          (a type union)

   That is a claim about the data, and by ruling 128 it belongs written down next to the predicate
   that depends on it. `actorAuthority`'s docblock explains `deletedAt: null` at length and does not
   mention `status`.

**What I did verify by measurement: `deletedAt: null` is load-bearing and is pinned.** Dropping it:

    // where: { id: ctx.membershipId, organizationId: ctx.organizationId }   <- deletedAt removed
    $ npx vitest run --project integration --no-file-parallelism \
        apps/api/src/modules/invitations/invitations.integration.spec.ts
    MUT6 EXIT=1
      × the actor's authority is re-read (ADR-0026) > refuses when the actor's membership is gone
        by the time the transaction runs
      Tests 1 failed | 35 passed (36)
    $ git checkout apps/api/src/modules/invitations/

So the brief's question — "is `deletedAt: null` load-bearing there?" — is answered yes, by
measurement, and the suite protects it. `ctx.membershipId` is also the right key: `resolveTenant`
sets it from the **live** membership row (`tenant-context.ts:127`), so a member removed and re-added
gets a new row with a new id and a stale context resolves nothing and is refused — fail-closed, and
the same outcome as removal.

**Cost if left.** Item 2 is the material one and it is small: one extra request's worth of writes
into an organisation being suspended, on the same window as Finding 4 and closed by the same fix.
Item 3 costs nothing today and costs a privilege bug the day someone writes `'INVITED'`.

---

# What I verified and found TRUE

These are the report's and the code's claims that I checked and that held. Each was run, not assumed.

**The verification commands, re-run on a clean tree.** The implementer's numbers are exact.

| Command | My exit | My result | Report's claim | Agrees |
|---|---|---|---|---|
| `pnpm test:integration` | `0` | 29 files, **554 tests passed**, 320.7s | 29 files, 554 tests | yes |
| `pnpm test` | `0` | 115 files, **1983 tests passed** | 115 files, 1983 tests | yes |
| `pnpm check:specs` | `0` | "144 spec files, each claimed by exactly one of: unit, integration, ui" | 144 spec files | yes |
| `pnpm format:check` | `0` | "All matched files use Prettier code style!" | green | yes |
| `pnpm lint` | `0` | 14/14 tasks (turbo cache hit on this tree) | 14/14 | yes |
| `pnpm typecheck` | `0` | 14/14 tasks (turbo cache hit on this tree) | 14/14 | yes |

Because `lint` and `typecheck` came back from turbo's cache, I re-ran them independently, bypassing
turbo: `npx tsc -p tsconfig.json --noEmit` in `apps/api` → **exit 0**; `npx eslint` over
`modules/invitations modules/memberships modules/audit` → **exit 0**.

**Environment note, not a finding.** `npx turbo run typecheck lint --force` fails on this machine at
`@sentinel/db#build` with `EPERM: operation not permitted, rename
'…\generated\client\query_engine-windows.dll.node.tmp…'` — a Windows file lock on the Prisma query
engine, reproduced twice including with nothing else running. It is not caused by this change:
`pnpm test` and `pnpm test:integration` both run `build:packages` first and both completed green,
and `--filter=@sentinel/db typecheck --force` passes in isolation.

**The red run was real.** I removed the feature (cascade returns `[]`; `create`'s
`assertActorMayGrant` given `ctx` again instead of `await actorAuthority(tx, ctx)`) and ran both
specs:

    MUT EXIT=1   Tests 9 failed | 69 passed (78)
    × D9 — CLOSED BY ADR-0026: an invitation does NOT outlive its issuer's authority
    × a cascade revocation frees the (organizationId, email) slot for a fresh invitation
    × refuses when the actor's membership is gone by the time the transaction runs
    × decides on the role the database holds, not the role the context claims
    × revokes every live invitation the removed member issued, and audits each one
    × leaves invitations issued by anybody else alone
    × revokes only the invitations a demoted member could no longer issue
    × revokes only in the organisation the member was removed from
    × writes the revocations inside the caller's transaction, so a later failure undoes them

**Nine of the eleven new tests fail when the feature is removed.** The two that do not are exactly
the two the report names — `revokes nothing on a promotion` and `revokes nothing on a role change to
the role the member already holds` — and the report is right that they are guard cases against
over-revocation and that mutation 2 is where they earn their place. This matches `d9-report.md`'s
red-run section line for line, including the 42/36 baseline counts. **That is an honest report of a
real red run**, and it is the strongest single thing I can say for this change.

**Mutation 3 survives, as reported.** Dropping `organizationId` from the cascade's read predicate:
`MUT3 EXIT=0, Tests 42 passed (42)`. (Its recorded *reason* is wrong — Finding 7.)

**Mutation 4 survives, as reported, and the claim behind it is arithmetically true.**
`remove` passing `new Set<string>()` instead of `null`: `MUT4 EXIT=0, Tests 42 passed (42)`. The
claim "every seeded system role holds at least one permission" computes to:
`OWNER=49 ADMIN=47 SECURITY_LEAD=33 MEMBER=23 VIEWER=12 AUDITOR=15 GUEST=11` — minimum 11, so the
empty set and `null` are behaviourally identical today and the ADR §1 reasoning for keeping `null`
is correct.

**`deletedAt: null` in `actorAuthority` is load-bearing and IS pinned.** Dropping it turns
`refuses when the actor's membership is gone by the time the transaction runs` red
(`MUT6 EXIT=1, Tests 1 failed | 35 passed (36)`). `ctx.membershipId` is also the right key —
`resolveTenant` sets it from the live row (`tenant-context.ts:127`), so a removed-and-re-added
member's stale context resolves nothing and is refused.

**The ES module cycle argument is sound at runtime**, notwithstanding Finding 3's overreach:

    $ grep -rn "from '../memberships/" apps/api/src/modules/invitations/ | grep -v spec
    invitation.service.ts:28:} from '../memberships/membership.service.js';     # the only one
    $ grep -rn "memberships.module" apps/api/src --include=*.ts | grep -v spec
    app.module.ts:22   + four occurrences inside comments — nothing in invitations/ imports it

`invitation-revocation.cascade.ts` imports only `@sentinel/db`, `audit/audit.service.js` and a
type from `auth/request-context.js`; `audit.service.ts` imports nothing from either module. The
only value edge `memberships/` → `invitations/` is `memberships.module.ts` → the cascade, and
nothing in `invitations/` imports `memberships.module.ts`. The graph is acyclic, and the 554
passing integration tests boot the whole Nest graph, which is the runtime measurement.

**`LIVE_INVITATION` has exactly one definition and no inline copy.**
`grep -rn "acceptedAt: null" apps/api/src --include=*.ts | grep -v spec` returns exactly one line:
the constant itself. (Its docblock's *count* is wrong — Finding 2.)

**The audit trail is correct in the ways the brief asked about.** Two producers, matching the
widened docblock: `invitation-revocation.cascade.ts:192` and `invitation.service.ts:608` (the
deliberate `revoke`). Three writers of `Invitation.revokedAt`: supersession
(`invitation.service.ts:389`), `revoke` (`:600`), the cascade (`:176`) — which is what the cascade's
docblock says. Every cascade event is written with the caller's `tx` via `AuditService.record`, so
it is inside the transaction; the rollback test proves it (and goes red when the feature is
removed). No forbidden field reaches an event: the cascade's `select` never loads `tokenHash`.
Supersession still writes no `INVITATION_REVOKED` — unchanged.

**Cross-tenant is genuinely closed, by three layers.** `Invitation` is in `TENANT_OWNED_MODELS`
(`packages/db/src/tenant-resources.ts:12`); `findMany` and `updateMany` are both scoped operations
(`packages/db/src/tenant-scope.ts:27,35`), so the extension injects `organizationId`; RLS is
`FORCE` and keyed on it; and the cascade names it explicitly in both statements. The test
`revokes only in the organisation the member was removed from` goes red when the feature is removed.
I could not break it with mutation 3.

**The cascade's two call sites are complete for this codebase.** The only writer of
`status: 'REMOVED'` is `membership.service.ts:680` (`remove`) and the only writer of an existing
membership's `roleId` is `:554` (`updateRole`); `accept` only *creates* a membership and is guarded
by `assertUserIsNotAlreadyAMember`. So there is no third path by which a live member's authority
shrinks without the cascade running.

**The conditional per-row write is right.** `updateMany` re-states `LIVE_INVITATION` and a
`count: 0` row gets no event, so a concurrent supersession cannot produce an audit row claiming a
revocation that did not happen. `create`'s lock is on `(org, address)` and the membership writes'
is on the organisation, so the concurrency the comment describes is real.

**`d9-report.md` is unusually honest about its own limits.** Its "I tested the mechanism, not the
race" section, residual risks 1-6, and both surviving mutations are disclosed rather than buried.
Finding 4 is a failure of the *design's* claim that the report inherited from ADR-0026, and residual
risk 1 shows the implementer was circling the right area. The report's specific factual defects are
Findings 1 and 7 only.

# What I could NOT verify, and why

- **How often Finding 4's race reproduces without help.** My probe widens the window with an
  env-gated `setTimeout` inside the cascade. I did not measure the unaided hit rate and make no
  claim about it. The window's *existence* does not depend on the delay (READ COMMITTED + no shared
  lock + a non-locking re-read), but its width does.
- **Whether adding `lockOrganization` to `create` closes the probe.** I did not try it: the brief
  forbids changing code, and I judged that a fix belongs to the orchestrator. I am confident of the
  mechanism and I have not measured the outcome.
- **Whether the cascade behaves correctly on an incomparable role change** (`ADMIN` → `SECURITY_LEAD`
  with a pending `AUDITOR` invitation). I read the filter and it should revoke; no test exercises it
  and I wrote none. Finding 9 rests on the mutation measurement, which I did run, not on this.
- **Self-removal end to end** (Finding 8). Reasoned, not measured.
- **`pnpm check:openapi` and `pnpm check:registry`.** Not run — neither was in the six commands, and
  nothing in the diff touches a contract, a response schema or the tenant registry. I did not verify
  that last statement beyond reading the diff's file list.
- **`apps/web`.** Explicitly out of scope; not looked at.
- **ADR-0026's decision itself.** Not re-litigated, per the brief. Having measured the rest, I think
  the decision is right and item 3 of it is incompletely implemented rather than wrong.

# Overall judgement

**The code is a real improvement and I would not throw it away. The claim attached to it is false,
and in its current form this must not merge as "the D9 window is closed".**

Everything the cascade does, it does correctly: eleven tests, nine of which I watched go red when I
removed the feature; the transaction discipline holds; cross-tenant holds under three layers and
resists the obvious mutation; the audit trail is per-invitation, in-transaction, and free of
anything §5 forbids; the module boundary is genuinely acyclic. Sequentially — which is every case
anyone will hit by accident — a removed or demoted member's invitations now die with their
authority, and that is the substance of ADR-0026 §1 and §2.

But ADR-0026 §3's claim is the one the change stakes its status on, and it does not hold. I
reproduced the original D9 escalation on this branch, through the real routes, to a `201` minting an
`OWNER` membership for a user whose row says `REMOVED` — and again for a demotion. The re-read is
necessary and it is not sufficient, which is the exact sentence the ADR quotes rulings 82 and 122
for and then commits the third instance of. Meanwhile the six documents that used to warn about this
have been rewritten to say it is shut, the test named to warn about it has been renamed, and
`authentication.md`'s paragraph is gone.

**What I would require before this merges:**

1. **Finding 4.** Either take `lockOrganization` in `InvitationService.create` — it is exported,
   already imported by that file for `accept`, and its own docblock says a writer outside the
   serialisation reopens the race for everyone — or downgrade the claim in all six places that make
   it (ADR-0026 §3 and its Consequences, `invitation.service.ts:290-317`, `roadmap.md`,
   `authentication.md`, `d9-brief.md`, `d9-review-brief.md`) and record the residue as owed, with a
   test that pins it the way the old D9 test pinned the original. **Deleting the warning while the
   window is open is the part I would block on**, more than the window itself.
2. **Finding 5.** `roadmap.md`'s section must not lead with the defect in the present tense.
3. **Finding 1.** Fix the four broken citations and correct the report's "both resolve".
4. **Finding 6.** `audit.md` §4 gets its paragraph, as Tasks 13, 14 and 15 each did.
5. **Finding 9.** One test on an incomparable pair, so the design's central claim is pinned.

Findings 2, 3, 7, 8, 10 and 11 are worth fixing and would not block.

**Severity roll-up:** 1 High (4), 4 Medium (1, 5, 6, 9), 6 Low (2, 3, 7, 8, 10, 11).

**Working tree.** Every file I mutated was restored with `git checkout` and `git status --short`
returned empty each time. The only file I changed or committed is this document.
