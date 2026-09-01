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
| **H1** | racing login mints a session the reset never sweeps | *(below)* |
| **M1** | reset CAS asserted only by a fake | *(below)* |
| **M2** | ruling 70's fifth channel | *(below)* |
| **M3** | `change-password` is a weaker guard than `login` | *(below)* |
| **L1–L7, P1–P7** | *(below)* |

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
