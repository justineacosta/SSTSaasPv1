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
