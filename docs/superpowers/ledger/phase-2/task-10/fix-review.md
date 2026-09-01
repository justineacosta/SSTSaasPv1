# Task 10 fix-round review — the second adversarial pass

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a second fresh adversarial reviewer on 2026-09-01, at `feat/phase-2-task-10` = `5a6de21`.
Code range reviewed: `2df56b7..5a6de21` — the fix round only. I did not write it, and I did not write
[`review.md`](review.md) either.

Everything below that says **measured** was run on this machine, on this tree, with the mutation
applied and reverted. Exit codes were captured outside a pipe. Probes were written as a scratch
`*.integration.spec.ts`, run, and deleted; `git status --porcelain` is empty apart from this file.

Written and committed **incrementally**, finding by finding.

---

## Verdicts

| | Finding | Verdict |
|---|---|---|
| **H1** | racing login mints a session the reset never sweeps | **CLOSED** — 0 survivors, 0 authenticating, over 5 rounds; 16 with the check disabled |
| — | the rehash trap | **CLOSED WITH A CAVEAT** — the trap is closed, by a different mechanism than the code says, and neither mechanism is tested (**NEW-1**) |
| **M1** | reset CAS asserted only by a fake | **OPEN** at Medium — the branch is now exercised by a real writer, and deleting the predicate still leaves the integration lane green. Honestly reported. |
| **M2** | ruling 70's fifth channel | **CLOSED** — mutation RED in three blocks. Sixth channel (`organizationName`) characterised; its pin is weaker than claimed (**NEW-2**) |
| **M3** | `change-password` is a weaker guard than `login` | **CLOSED WITH A CAVEAT** — the notice works, is consecutive, and touches neither the ladder nor the response; "once per burst" is defeated by concurrency (**NEW-3**) |
| **L1, L2, L4, L5, L6, L7** | | **CLOSED** (L4 correctly closed *as recorded*) |
| **L3** | breach check and hash paid before the token is validated | **PARTIALLY FIXED** — site half done, document half claimed and absent (**NEW-5**) |
| **P1–P7** | | **CLOSED** — and two new false sentences were introduced beside them (**NEW-4**, **NEW-5**) |

**New defects: two Medium, three Low. Nothing at High** — stated plainly, having gone looking.

---

## H1 — CLOSED

**The probe, re-run by me rather than trusted.** A scratch integration spec firing one
`reset-password` and five `POST /auth/login` with the **old** password in one `Promise.all`, five
rounds, counting `Session` rows with `revokedAt: null` **and** driving every returned cookie at
`GET /auth/session`:

```
P-A
ROUND 0: reset=200 logins=200,200,200,401,401 live=0 auth=0
ROUND 1: reset=200 logins=200,401,401,401,401 live=0 auth=0
ROUND 2: reset=200 logins=200,401,200,401,401 live=0 auth=0
ROUND 3: reset=200 logins=200,200,200,401,401 live=0 auth=0
ROUND 4: reset=200 logins=401,200,401,401,401 live=0 auth=0
TOTAL live=0 auth=0
```

**Zero survivors and zero authenticating cookies.** The `rememberMe: true` run — the worst version,
30-day absolute clock — is the same:

```
P-B
ROUND 0: reset=200 live=0 auth=0   ROUND 1: ... live=0 auth=0   ROUND 2: ... live=0 auth=0
TOTAL live=0 auth=0
```

**The probe is not vacuous.** Mutation: `if (false && !(await this.credentialStillCurrent(...)))` at
`login.service.ts:682`, everything else untouched. Same five rounds:

```
ROUND 0: reset=200 logins=200,200,200,200,200 live=4 auth=4
ROUND 1: reset=200 logins=200,200,200,200,200 live=2 auth=2
ROUND 2: reset=200 logins=200,200,200,200,200 live=2 auth=2
ROUND 3: reset=200 logins=200,200,200,200,200 live=4 auth=4
ROUND 4: reset=200 logins=200,200,200,200,200 live=4 auth=4
TOTAL live=16 auth=16
```

and the **committed** suite bites on the same mutation — the fix round's own test is not decorative:

```
pnpm vitest run --project integration ...auth.password.integration.spec.ts -t "H1"
EXIT=1
× leaves ZERO usable sessions across five rounds of five racing logins → expected 11 to be +0
× does the same when the racing logins ask to be remembered      → expected [...] to have a length of +0 but got 2
✓ still lets an ordinary login through when nothing is racing it
✓ does not revoke a login that rehashed its own credential
```

Reverted; `git checkout -- login.service.ts`, tree clean.

**The interleaving argument, checked rather than accepted.** The code and `fixes.md` claim there is
no third ordering. I agree, and the reason is stronger than the comment states: the reset commits
the credential (T1) strictly before its revoke statement begins (T2), and the login re-reads (T4)
strictly after its own `Session` insert (T3).

- T3 < T2 → `revokeLiveForUser`'s predicate is evaluated at execution time and sweeps the row. This
  is the case that produces the `logins=200` entries above: the login answers 200 and hands back a
  cookie for a session that is already dead. Measured `auth=0` for every one of them.
- T3 > T2 → then T3 > T2 > T1, so T4 > T1 and the re-read observes the new hash.

**The re-read racing does not open a hole**, and this is worth stating because the brief asks. If
T4 lands *before* the reset's commit, the check passes and the session stands — but that ordering
necessarily has T3 < T4 < T1 < T2, which is the first case, and the revoke sweeps it. The check
being "too early" is safe precisely because being too early implies being inside the revoke's reach.

**It compares meaning, not bytes**, and I checked that this is not a hole either. On a mismatch
`credentialStillCurrent` re-verifies the submitted password against the hash now stored. An attacker
racing a reset submits the *old* password, which does not verify against the new hash → revoked. The
only way the re-verify returns true on a changed row is if the new hash accepts the same password —
i.e. a concurrent rehash of the same credential, or somebody resetting to the identical password.
Neither is a privilege the attacker did not already have.

**The MFA arm is covered.** The check sits before the `mfa-required` return, so a `PENDING_MFA`
session is subject to it. Measured on an account with a confirmed `MfaFactor` seeded directly:

```
P-C
ROUND 0: reset=200 live=0    ROUND 1: reset=200 live=0    ROUND 2: reset=200 live=0
TOTAL live=0 mfaTokens=0
```

Zero live `Session` rows of any status. (`mfaTokens=0` is my probe reading the wrong body field, not
a finding — see *What I could not check*.)

**`change-password`'s equivalent window is still open and is still only protected by timing.** Not a
regression — the fix round names it in `fixes.md` §4 and in `security/authentication.md` §6 rather
than claiming otherwise — and I reproduced the same benign outcome the first reviewer did:

```
P-D  (change-password racing five old-password logins, 5 rounds)
ROUND 0..4: change=200 logins=200,200,200,200,200 liveRows=1 oldPwAuth=0
TOTAL liveRows=5 (the five rotated callers) oldPwAuth=0
```

Every racing login answered 200, every one of their cookies was dead. That is the change path's
`revokeAllForUser` sweeping them, not the post-issue check — the same accident, disclosed as an
accident. **Grade: not a new finding, correctly recorded as open.** See the New defects section for
whether it should have been fixed here.

**Verdict: CLOSED.**

---

## The rehash trap — CLOSED WITH A CAVEAT (and it yields NEW-1, a Medium)

**The trap itself is closed.** A rehashing login does not revoke itself, and a rehash racing a
password change does not resurrect the old password. Both measured.

A login that rehashes its own credential, nothing racing it — the committed test
`does not revoke a login that rehashed its own credential` passes, and my own round of it agrees:
the credential row moves off the weak hash, the session stays live, and the cookie answers 200.

Six rounds of one `change-password` racing five *rehashing* logins (credential seeded at
`m=8,t=1,p=1` so every login rehashes), then both passwords tried afterwards:

```
P-E
ROUND 0: change=200 oldPasswordAfter=401 newPasswordAfter=200
ROUND 1: change=200 oldPasswordAfter=401 newPasswordAfter=200
ROUND 2: change=200 oldPasswordAfter=401 newPasswordAfter=200
ROUND 3: change=401 oldPasswordAfter=200 newPasswordAfter=401
ROUND 4: change=200 oldPasswordAfter=401 newPasswordAfter=200
ROUND 5: change=200 oldPasswordAfter=401 newPasswordAfter=200
```

Round 3 is the change losing its own compare-and-swap to a concurrent rehash: it answers 401 and
does not commit, so the old password is legitimately still the account's. **No round resurrected a
password that had been replaced** — `rehashCredential`'s `where: { userId, passwordHash:
verifiedHash }` is what prevents it, and it holds. Six rounds of one *reset* racing five rehashing
logins is the same story with no refusals at all:

```
P-F
ROUND 0..5: reset=200 liveRows=0 auth=0 old=401 new=200
```

**The caveat: the mechanism the code says closes the trap is not the mechanism that closes it, and
neither half is observed by either lane.**

`login()`'s comment says the rehash and the check "have to happen in a known order, in one place,
**or a rehashing login revokes itself**". The integration test's docblock says the same: "a
post-issue comparison against the hash the request originally READ … **every rehashing login would
revoke itself**." Both are false.

**Measured.** Mutation: `if (false && rehashed !== null) hashInForce = rehashed;` — the plumbing
that carries the written hash forward is defeated, so the check compares against the hash the
request originally read, which is exactly the scenario both sentences name.

| Lane | Result |
|---|---|
| `pnpm vitest run --project unit apps/api/src/modules/auth` | EXIT=0 — **27 files, 564 tests, all green** |
| `...--project integration auth.password.integration.spec.ts` | EXIT=0 — **31 tests, all green**, `does not revoke a login that rehashed its own credential` **passes** |

No rehashing login revokes itself, because `credentialStillCurrent` does not stop at the byte
comparison: on a mismatch it re-verifies the submitted password against whatever is stored now, and
a rehash of the same password verifies. The `hashInForce` plumbing — the rehash moved before
`issue`, `rehashCredential`'s changed return type, the `credential` parameter threaded into
`succeed` — is a **fast path that saves one Argon2id verification**, not a correctness control.

**And the control that IS load-bearing has no test at all.** Mutation: delete the re-verify fallback
(`return (await this.passwords.verify(current, password)).valid;` → `return false;`).

| Lane | Result |
|---|---|
| `...--project integration auth.password.integration.spec.ts` | EXIT=0 — **31 tests, all green** |

Green, because in the committed rehash test `hashInForce` is correct and the fast path answers
first. So each half individually can be deleted with the whole suite green. What that fallback
actually holds, measured with a scratch probe — four concurrent logins with the **correct**
password against an account whose credential is stored at weak parameters:

```
G   with the fallback (HEAD)          with the fallback deleted
ROUND 0: 200,200,200,200 live=4       ROUND 0: 401,401,200,401 live=1
ROUND 1: 200,200,200,200 live=4       ROUND 1: 200,401,401,401 live=1
ROUND 2: 200,200,200,200 live=4       ROUND 2: 200,401,401,401 live=1
ROUND 3: 200,200,200,200 live=4       ROUND 3: 401,401,200,401 live=1
```

**Three of four correct-password sign-ins refused**, for the whole duration of an Argon2 parameter
migration — which is the one condition D8's rehash exists to serve. The `credentialStillCurrent`
docblock predicts exactly this ("would make two simultaneous sign-ins with the correct password
refuse each other for the lifetime of a parameter migration") and then ships no test for it.

**NEW-1 (Medium).** Two sentences written this round state a failure mode that does not exist, the
test named for that failure mode does not observe it, and the availability control that does the
real work is observed by nothing in either lane. This is not a security hole — every measured
outcome at HEAD is correct — it is ruling 74's cost on a third endpoint: a reader is told the wrong
thing about why the code is safe, and a refactor can delete either half with the eleven-command gate
green. What is owed is (a) a login-service unit test pinning "two concurrent rehashing logins with
the correct password both succeed", which the mutation above turns red, and (b) rewording the two
sentences to say what the plumbing buys, which is one Argon2id verification per rehashing login.

All mutations reverted; `git checkout -- login.service.ts` after each.

---

## M2 — CLOSED (the fifth channel). The sixth is characterised below, and yields NEW-2, a Low.

**No template renders any stored `User.name`, and it is structural rather than asserted.**
`grep -rn inviterName` over `apps/`, `packages/`, `scripts/` and `.claude/` finds it in exactly two
places outside `dist/`: `registry.spec.ts`'s fixture type (deliberately — the field is now consumed
by nothing, which is what makes the ruling-70 blocks a structural assertion for it) and prose. The
complete set of caller-influenced string fields across the whole registry is now:

```
TokenLinkInput      : webBaseUrl, token, ttlSeconds
InvitationInput     : + organizationName
NoticeOccurrenceContext : occurredAt, ipAddress?
MfaChangedInput     : + change
FailedLoginBurstContext : occurredAt, attemptCount
```

One free-text field, in one template. `pnpm typecheck` is the control, as claimed.

**Mutation M reproduced.** `inviterName` restored to `InvitationInput`, rendered into the first
paragraph, and re-added to `CASES.invitation`:

```
pnpm vitest run --project unit .../emails/registry.spec.ts   EXIT=1
× template invitation under ruling 70 > renders the recipient display name nowhere, even when it is a URL
× token-link invitation under ruling 70 prescribed payload > contains exactly one link, the one this code built
× the organisation name residual > renders no link from any field EXCEPT the organisation name
Tests 3 failed | 128 passed (131)
```

Three blocks, exactly as `fixes.md` claims. Reverted.

### The sixth channel: exactly what `organizationName` can do

Rendered from the shipped module with a hostile value
(`Acme https://evil.example/login?t=1 \r\nBcc: x@evil.test <script>steal()</script> AAAA…`):

| Where it lands | What survives |
|---|---|
| SMTP `Subject:` header | **CR and LF collapsed to spaces.** No header injection. |
| `text` part — the subject is repeated as the first block | raw, including any URL |
| `text` part — the body paragraph | **raw, INCLUDING the CR/LF**, so it can forge additional lines |
| `html` part (`<title>` and `<h1>` and the paragraph) | HTML-escaped — `&lt;script&gt;`, no `<script>` |

**SMTP header injection is closed, at two layers**, and this resolves the first reviewer's open
question. `layout.ts:172` passes every subject through `sanitizeSubject` before it leaves
`renderEmail`, and `smtp-mailer.ts:192` does it again at the port — with unit tests pinning both
(`sanitises the subject at the port, not only inside renderEmail`,
`collapses any control character in the subject, not only CR and LF`). Nothing an organisation name
contains can become a header.

**What it genuinely can do is one step past what the fix round wrote down.** The documents say "a
tenant who puts a URL in their organisation name gets it autolinked in the text part of every
invitation they send", which is true and incomplete. The value also carries **newlines into the
plain-text body**, so it can forge whole extra paragraphs inside a message that already carries a
live token link — the phishing primitive is not "one bare URL" but "arbitrary attacker-authored
lines above the product's own link". And `Organization.name` is a bare Prisma `String` with **no
length cap in the schema** and no Zod constraint anywhere yet, so it is also unbounded. That is what
Task 13 has to constrain, and "reject URLs" would not be sufficient on its own.

### NEW-2 (Low) — the residual is pinned less tightly than its docblock says

`registry.spec.ts`'s new block claims to pin `organizationName` "from both sides", and that the
second test "asserts that `organizationName` **does** still reach the body as given, so the day
somebody constrains it this block goes red".

**Measured — two independent mutations, each leaving the whole file green:**

| Mutation | Result |
|---|---|
| body paragraph → `You have been invited to join an organisation on Sentinel.` | EXIT=0, **131 passed** |
| subject → `You have been invited to an organisation on Sentinel` | EXIT=0, **131 passed** |

Neither bites, because `renderEmail` puts the subject into `text` as its first block
(`layout.ts:159`), so `expect(email.text).toContain(INJECTED_URL)` is satisfied by *either* site
alone. The block goes red only if the name is removed from **both**. It also would not go red at all
for the constraint the docblock actually anticipates — Task 13 validating `Organization.name` on the
way in — because this test hands the fixture straight to the template and never passes through Task
13's validation.

Not a security defect: the residual is real, recorded, and grades correctly. It is a coverage
overstatement of exactly the kind this round was convened to remove, in one of the sentences this
round wrote. Cost if left: a future round that removes the name from the body and leaves it in the
subject will believe the residual is closed while it is not.

**M2 verdict: CLOSED.**

---

## M3 — CLOSED WITH A CAVEAT, and it yields NEW-3, a Medium

**What holds, measured through the real application.**

Twelve consecutive refused current passwords on one account (sequential), driven at the HTTP
endpoint:

```
H statuses=401,401,401,401,401,401,401,401,401,401,401,401  notices=1  allMail=failedLoginBurst
```

One notice, twelve identical 401s. The response does not vary on the attempt that sends — the
threshold is not observable from outside.

**The `consecutive`, not merely `recent`, correction is real and works end to end.** Four refusals,
one successful change, four more refusals:

```
J changeStatus=200  noticesAfterReset=0
```

Zero. A success resets the run, exactly as `login`'s ladder does. This is the unpredicted red the
implementer reports in `fixes.md` §2 and it was fixed correctly.

**The ladder is untouched.** The committed integration test asserts `failedLoginCount === 0` and
`lockedUntil === null` after five refusals; I re-ran the file and it passes, and the unit lane
additionally asserts `tx.user.updateMany` is never called on this path.

**The `gt` / `gte` boundary correction is unobserved by either lane.** Mutation: `createdAt: { gt:
since }` → `createdAt: { gt: new Date(since.getTime() - 1) }`, which is `gte` at the fake's clock
resolution.

```
pnpm vitest run --project unit .../password-change.service.spec.ts   EXIT=0   26 passed
```

The correction is defensively right and honestly reported, and nothing can currently see it — the
fake stamps rows a millisecond apart and real Postgres stamps microseconds, so the tie the boundary
guards against does not occur in either lane. Noted rather than graded; there is no behaviour to be
wrong.

(Recording a trap for the next round, in L2's family: the *obvious* mutation here — renaming the key
to `gte` in `password-change.service.ts` — produces five red tests that are all
`TypeError: Cannot read properties of undefined`, because `identity-fakes.ts` reads
`args.where.createdAt.gt` by name. That red observes the fake, not the boundary.)

### NEW-3 (Medium) — "once per burst" is defeated by concurrency, and the comment that states it as a guarantee was written this round

`password-change.service.ts` says, of `if (failures !== BURST_THRESHOLD) return null;`:

> **ONCE PER BURST, NOT ONCE PER FAILURE PAST IT. Exactly equal, not `>=`:** … a message per failure
> would make this notice an **outbound-email amplifier aimed at the account owner, triggered at will
> by whoever holds the session**.

The count is read *inside* the same interactive transaction that writes the denial row. Prisma's
interactive transactions run at Postgres READ COMMITTED, so concurrent denials do not see one
another's uncommitted rows and several can each count exactly `BURST_THRESHOLD`.

**Measured**, four rounds of *four sequential* refusals (count reaches 4, no notice) followed by
*eight concurrent* refusals on the same session:

```
I round=0 statuses=401×8  noticesBefore=0  noticesAfter=1
I round=1 statuses=401×8  noticesBefore=0  noticesAfter=1
I round=2 statuses=401×8  noticesBefore=0  noticesAfter=2
I round=3 statuses=401×8  noticesBefore=0  noticesAfter=3
```

**Two rounds of four produced more than one notice; one produced three.** That is the amplifier the
comment names, at a smaller multiple than "one per failure" but by the same mechanism, and the
guarantee as written is false.

**Why nothing saw it.** Every test of this control is sequential — the eight unit tests loop
`await fail(service, n)`, and the integration test loops five awaited requests. This is carry-forward
ruling 74 verbatim, in the fix round for a finding whose own dispositions cite ruling 74: *a control
that only arbitrates under concurrency, asserted only sequentially*. The same file, twenty lines
away, contains `LETS EXACTLY ONE OF TWO PARALLEL CHANGES COMMIT`, which is the probe shape this
needed.

**Cost if left.** Bounded — `passwordChange` is `perIp: { limit: 10, windowSeconds: 3600 }`, so one
address buys at most ten attempts an hour — but it is an outbound send the product pays for, aimed
at the account owner, multiplied at will by whoever holds the stolen session, and it grows with the
number of source addresses. It also degrades the signal: an owner who receives three identical
notices for one burst learns less, not more. And separately: because `windowStart` slides, the notice
is really *once per fifteen minutes* rather than once per burst — a session thief who keeps guessing
earns a fresh notice every window, indefinitely. That second half is arguably the desired behaviour
(it matches `login`), but "once per burst" is not what the code does either way.

**The fix is small**: make the read-and-decide atomic — an `INSERT … RETURNING` ordinal, a conditional
update on a marker row, or a Redis `INCR`-style once-per-window key — and add the parallel probe.

**M3 verdict: CLOSED WITH A CAVEAT.** The row the review asked to be filled in *is* filled in: the
owner is now told, the ladder is untouched, the response does not vary, and the count is consecutive
and read from the real audit table. What is not true is the "once per burst" guarantee.

---

## M1 — OPEN, and I judge the limit acceptable while the ruling cited for it is wrong

**What was built is real.** The probe now puts a genuine committed second writer into the reset's
window: the account's credential is seeded at `m=8,t=1,p=1` so every concurrent login rehashes it.
That is a real competing `UPDATE` on the same row, not a fake's flag, and it is a strictly better
control than what `review.md` found. `identity-fakes.ts`'s false claim (P6) is corrected precisely,
and it now says which half of the coverage exists and which does not.

**The gap is real too, and it is reported honestly.** I reproduced the shape of the problem: I fired
one `reset-password` against five rehashing logins and could not force the reset's predicate to lose
on demand either. Across my own six rounds it lost in **zero** of them:

```
P-F
ROUND 0..5: reset=200 liveRows=0 auth=0 old=401 new=200
```

which is consistent with the implementer's reported 3-in-20 and confirms the honest characterisation:
the branch is reachable, at a rate that is scheduling rather than logic. The committed probe asserts
what holds every round — one working password, the status code agreeing with it, and the link
surviving a refusal — and its own docblock states that deleting the predicate does not turn that red.
That is the right disclosure and it is the shape `review.md` asked for everywhere else.

**Verdict: OPEN**, at Medium, unchanged from `review.md`'s grade. The disposition's second half —
"delete the predicate and paste the red output" — was not delivered and cannot be, and the fix round
says so plainly rather than faking it, which is the correct behaviour under the brief's last rule.
But the finding as `review.md` stated it is *"the reset's compare-and-swap is asserted only by a
fake; deleting it leaves all 25 integration tests green"*, and deleting it still leaves the
integration lane green. Nothing observes the predicate. The improvement is that the branch is now
exercised and the gap is now written down instead of contradicted.

**What I would accept as closing it**, since "prove it with a probe" has now failed twice: widen the
window deliberately in a test-only seam — a `$queryRaw('SELECT pg_sleep(...)')` or an injected delay
between the reset's in-transaction credential read and its write, driven only from the spec — so the
competing writer lands inside it deterministically. That is not a flaky assertion; it is making the
interleaving a fixture rather than a coin flip, which is what `LETS EXACTLY ONE OF TWO PARALLEL
CHANGES COMMIT` already achieves for the change path by accident of its slower pre-transaction phase.

### NEW-4 (Low) — the argument for leaving it open cites a ruling that says something else

Both `fixes.md` §3 and, more seriously, the **committed** docblock in
`auth.password.integration.spec.ts` say:

> this repository has a standing ruling about not trading determinism for coverage (**ruling 33**),
> and a flaky red is worse than an honest gap

**Ruling 33 says nothing of the kind.** Its full text in `progress.md`:

> 33. **The integration suite runs sequentially, and that is load-bearing.** `fileParallelism:
>     false` in `vitest.workspace.ts` had never been in force … Two suites share the
>     `ratelimit:login:*` namespace on the one compose Redis … **Do not restore parallelism without
>     namespacing the shared services first** …

It is about test-runner parallelism and shared compose services. The proposition actually being
invoked belongs to **ruling 22** — *"real parameters buy CI flake risk rather than proof"*, whose
own closing sentence is *"A decision can be right while the reason written beside it is false, and
the false reason is still a defect."*

This is ruling 11's class: a ruling number attached to a claim the ruling does not make, reaching a
code comment. The previous reviewer checked all thirty citations in the previous range and reported
that every one held — *"That is a first for this range"*. This round broke the streak with one.

**The other nine citations added this round all check out**, opened individually in `progress.md`:

| cited | at | holds? |
|---|---|---|
| 44 | `password-change.service.ts` — mail after the commit | ✓ |
| 51 | `session.service.ts` — carries the same overstatement | ✓ (51's last sentence *is* the overstatement) |
| 53 | `fixes.md` P3 row — "correction carried at the site" | loose (53's precedent is for a source that *cannot* be edited; this one was edited in place) but not false |
| 55, 59 | the owed per-principal limiter stage | ✓ |
| 58 | fixtures all on one side of the branch | ✓ |
| 70 | the display-name channel | ✓ |
| 73 | a write decided from a pre-hash read | ✓ |
| 78 | the burst notice's send inside the request, third endpoint | ✓ |

### NEW-5 (Low) — L3's cross-reference names a document sentence that was never written

`password-reset.service.ts` now says, of the breach check and hash paid before the token is
validated:

> `security/abuse-prevention.md` §1 carries the same sentence beside the figure, so whoever tunes it
> can see what it is holding.

and `fixes.md`'s L3 row says the consequence was written "at the site **and beside the figure in
`abuse-prevention.md` §1**".

**Measured:** `git diff --stat 2df56b7..5a6de21 -- .claude/` lists three files —
`api/authentication.md`, `security/audit.md`, `security/authentication.md`. **`abuse-prevention.md`
was not touched by this round.** Its `passwordResetConsume` paragraph does say the endpoint "pays a
full **Argon2id hash** of the submitted password on every request", which is why this is a Low and
not a fabrication — but it does not say the expensive work is bought *before the token is validated*,
which is the whole of L3, nor that the per-IP figure is therefore the only control in front of it.
The reader the sentence is written for — "whoever tunes it" — does not learn the thing at the figure.
`review.md`'s L3 asked for exactly that sentence, "beside the figure".

**L3 verdict: PARTIALLY FIXED.** The site half is done well; the document half is claimed and absent.

---

## L1–L7 and P1–P7

| | Verdict | Evidence |
|---|---|---|
| **L1** | CLOSED | `grep -rn ownSessionRotated` over `apps/`, `packages/`, `.claude/` finds it only in the comment recording its removal and in the ledger. The field is gone rather than corrected, which is right — there was nothing true to write. |
| **L2** | CLOSED | `identity-fakes.ts` now records the trap and names the honest alternative mutation. I hit a *new* instance of the same family in M3 (renaming `gt` to `gte` makes the fake throw `TypeError` on `args.where.createdAt.gt`) and recorded it above, in the same spirit. |
| **L3** | **PARTIALLY FIXED** | Site half done and well argued. Document half claimed and absent — NEW-5. |
| **L4** | CLOSED as recorded, correctly | Both halves are now written at `password-reset.service.ts` and in `security/authentication.md` §6, with "**Binds Phase 11**" and the two acceptable Phase 11 answers named. The disposition said record, not fix, and that is what happened. |
| **L5** | CLOSED | Mutation: delete the whole `tx.user.update` block → `× confirms an address that a completed reset just proved (L5)`. I also checked the new stamp cannot escalate anything: the only read of `emailVerifiedAt` on the login path is `login.service.ts:708`'s unfamiliar-sign-in notice; login itself never gates on it, so stamping it grants no access. |
| **L6** | CLOSED | `audit.md` §4 now states the change row excludes the caller's own session, matches the code's `id: { not: command.sessionId }`, and names L6. |
| **L7** | CLOSED | Same mutation → `× clears a live brute-force lock, so the new password actually works (L7)`. Administrative locks (`User.status`) deliberately untouched, and the reason (D4 refuses those links) is stated. |
| **P1** | CLOSED | The false sentence is gone and replaced with the true one — the ordering is necessary and not sufficient, and it names the other half. Written against the code as it ended up, which is what the disposition asked. |
| **P2** | CLOSED | §6 rewritten: 25 of 25, thirty days, window one Argon2id verification wide and growing with the parameter, and it now describes the fix rather than the residual. |
| **P3** | CLOSED | `git diff 2df56b7..5a6de21 -- session.service.ts` is no longer empty. The paragraph is corrected in place, names the mechanism that keeps the promise, and warns that Task 14's equivalent does not exist. |
| **P4** | CLOSED | `api/authentication.md` §9 and the controller docblock both now say which two mechanisms make "every session" true. `check:openapi` is byte-identical at 13 routes, so the client-facing `description` is unchanged and is now accurate. |
| **P5** | CLOSED | The docblock no longer claims "no exempt list"; it says which block covers what, and mutation D proves both blocks now reach `invitation`. |
| **P6** | CLOSED | `identity-fakes.ts` states which half of the integration coverage exists (`change-password`) and which does not (the reset), and does not overclaim the new probe. |
| **P7** | orchestrator's, reported not written | Correctly escalated rather than edited unilaterally. |

**Two new false sentences were introduced while correcting these**, which is the pattern the brief
warned about: the ruling-33 citation (NEW-4) and the `abuse-prevention.md` cross-reference (NEW-5).
Both sit in the same commit as corrections they stand beside.

---

## New defects introduced or left by the fix round

| | Grade | Finding |
|---|---|---|
| **NEW-1** | Medium | Two sentences state a failure mode that does not exist ("a rehashing login revokes itself"); the test named for it does not observe it; and the availability control that actually prevents it — the re-verify fallback in `credentialStillCurrent` — is observed by nothing in either lane. Measured: deleting either half leaves 564 unit and 31 integration tests green; deleting the fallback refuses **3 of 4** concurrent correct-password sign-ins during a parameter migration. |
| **NEW-3** | Medium | M3's "ONCE PER BURST" guarantee is defeated by concurrency. Measured: 4 sequential plus 8 concurrent refusals produced **2 and 3** `failedLoginBurst` notices in 2 of 4 rounds. Every test of the control is sequential — carry-forward ruling 74 verbatim, in the fix for a finding whose dispositions cite ruling 74. The false guarantee has also propagated to `api/authentication.md` §9 ("once per burst"). |
| **NEW-2** | Low | The `organizationName` residual is pinned less tightly than its docblock claims. Measured: removing the name from the body **or** from the subject each leaves all 131 tests green, because `renderEmail` puts the subject into the text part. It also would not go red for the Task 13 constraint the docblock anticipates. |
| **NEW-4** | Low | Ruling 33 is cited, in shipped code, for a proposition it does not contain (ruling 22 is the one that does). Ruling 11's class; the previous range's thirty citations all held. |
| **NEW-5** | Low | `password-reset.service.ts` and `fixes.md` both say the L3 consequence was written into `abuse-prevention.md` §1. That file was not touched by this round. |

**Nothing at High.** I say that having attacked the fix rather than read it: the racing-login probe
at five rounds and at `rememberMe`, the MFA arm, the reset-vs-rehash and change-vs-rehash
interleavings, the re-read's own ordering, the meaning-comparison's failure modes, the SMTP subject
path, and the burst notice under concurrency. The one thing that produced a genuinely new
*behaviour* defect is NEW-3, and it multiplies notification emails rather than granting access.

**Also worth the orchestrator's attention, though not a defect of this round:** `change-password`
still has H1's window and is protected only by timing. It is correctly disclosed in three places,
and I reproduced the benign outcome (P-D: zero old-password sessions usable in five rounds). The fix
is the same four lines that closed it on the login path, applied to that path's *other* trigger —
and `session.service.ts`'s own new paragraph says every caller needing "and nothing survives" must
pair the revoke with such a check. Leaving the one that already exists unpaired for another task is
a choice, not a constraint.

---

## Verification I ran on the finished tree

Exit codes captured outside a pipe. Tree clean apart from this file.

| Command | Exit | Output |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **83 files, 1362 tests** |
| `pnpm check:specs` | 0 | 102 spec files, each claimed by exactly one project |
| `pnpm test:integration` | 0 | **19 files, 323 tests**, 115 s — `M1 probe: reset predicate refused in 1/8 rounds` |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 13`, byte-identical |
| `pnpm check:registry` | 0 | 15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global |
| `pnpm check:secrets` | 0 | 388 tracked files, no credential-shaped literals |
| `docker compose ps` | 0 | four services `Up (healthy)` |

Every row in `fixes.md` §5 reproduces exactly.

### Mutations I applied and reverted

| | Mutation | Result |
|---|---|---|
| A | `if (false && !(await this.credentialStillCurrent(...)))` | **16 survivors, 16 authenticating**; committed H1 tests **RED x2** |
| B | `if (false && rehashed !== null) hashInForce = rehashed;` | unit **GREEN 564**, integration **GREEN 31** — NEW-1 |
| C | `credentialStillCurrent`'s re-verify becomes `return false` | integration **GREEN 31**; 3 of 4 concurrent correct-password logins refused — NEW-1 |
| D | restore `inviterName` and render it | registry.spec **RED x3 blocks** — reproduces the implementer's mutation M |
| E | drop `organizationName` from the invitation body | **GREEN 131** — NEW-2 |
| F | drop `organizationName` from the invitation subject | **GREEN 131** — NEW-2 |
| G | `createdAt: { gt: new Date(since.getTime() - 1) }`, i.e. gte semantics | **GREEN 26** — the boundary correction is unobserved |
| H | delete the reset's `tx.user.update` (L5 and L7) | **RED x2**, one per finding |
| I | 8 concurrent refused current passwords after 4 sequential | **2 and 3 notices** in 2 of 4 rounds — NEW-3 |

The tree was restored after every mutation, and the three scratch probe specs were deleted.
`git status --porcelain` is empty apart from this file.

---

## What I could not check

- **`pnpm test:e2e`.** Not run, and it correctly has no row — `git diff --stat 2df56b7..5a6de21` is
  empty for `apps/web`, `packages/ui` and `packages/db/prisma/migrations`, which I verified.
- **My MFA probe reported `mfaTokens=0`** because I read `body.mfaToken` and the contract's
  discriminated union names that field differently. The `live=0` count it reports is a direct
  `Session` query and is sound, so the MFA-arm conclusion stands; I did not separately confirm from
  the response body that the `PENDING_MFA` arm was taken, beyond the seeded confirmed `MfaFactor`.
- **Production Argon2id cost.** The ~250 ms figure everything here reasons about is ADR-0014's
  target (carry-forward ruling 23), not a measurement. This harness runs at reduced parameters, so
  every window in this document is narrower here than it is in production.
- **The timing figures in `security/authentication.md` §6.** Unchanged by this round; I did not
  re-run them, as the previous reviewer did not.
- **Behaviour under a real SMTP relay.** The harness mailer is in-memory, so NEW-3's amplification
  was measured as recorded `OutgoingMail` objects rather than as delivered messages.
- **How far NEW-3 amplifies at scale.** I measured up to 3 notices from 8 concurrent requests on one
  account and did not explore the maximum. The per-IP class of 10/hour is the practical bound from a
  single address; I did not measure it from several.
