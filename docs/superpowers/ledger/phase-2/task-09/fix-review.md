# Task 9 fix review — the second adversarial pass

> **A dated record of what was measured and found at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by a second fresh reviewer on 2026-09-01, on `feat/phase-2-task-09` at `cac6372`, over the
fix range `629f28d..cac6372`. I did not write these commits and I did not write the twelve findings
they answer. This pass exists because Task 8's fix round was never reviewed and that is how it
shipped an open High.

Everything below was run on this tree. Exit codes were captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`). Every mutation was applied, run and reverted; `git status` was
empty before I wrote this file, and both lanes are green as I write it.

**Verdicts: 8 CLOSED, 4 CLOSED WITH A CAVEAT, 0 OPEN. New defects: 0 High, 1 Medium, 4 Low.**

---

## 1. The gate reproduces

All eleven rows of [`fixes.md`](fixes.md) §6, re-run here:

| Command | Exit | Reproduced |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | **81 files, 1268 tests** |
| `pnpm check:specs` | 0 | `99 spec files … No banned .test.* spellings.` |
| `pnpm test:integration` | 0 | **18 files, 286 tests** |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | `routes: 10`; byte-identical |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `383 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | four services `Up (healthy)` |

The movement table reproduces too: 1252 → 1268 unit, 275 → 286 integration, no migration.

---

## 2. Per-finding verdicts

### H1 — the lockout ladder under concurrency. **CLOSED WITH A CAVEAT.**

I did not read their test. I wrote my own integration spec against the real application and ran it
(`apps/api/src/modules/auth/zzprobe.integration.spec.ts`, since removed; the tree is clean):

```
PROBE-A statuses 401,401,401,401,401  count=5  locked=2026-09-01T…  ACCOUNT_LOCKED=1
        counts=1,2,3,4,5  mails=failedLoginBurst
PROBE-A correct-after=403
PROBE-B seeded-at-4, five parallel  count=5  locked=true  mails=failedLoginBurst
PROBE-E ten parallel  401,401,401,401,401,429,429,429,429,429  count=5  ACCOUNT_LOCKED=1
        mails=failedLoginBurst
PROBE-D already-locked, two parallel CORRECT passwords  403,403
```

Every number the review measured as broken is now right, through the real endpoint: the counter
reaches five, the lock engages, the ladder produces one `ACCOUNT_LOCKED` row and exactly one burst
notice, each `LOGIN_FAILED` row carries a distinct `consecutiveFailures`, and a correct password
afterwards is refused. Ten parallel attempts do not overshoot — the limiter takes the last five.

Both halves of the mechanism are protected by a test that can fail:

| Mutation | Suite | Result |
|---|---|---|
| Ladder computed from the stale pre-hash read (`user.failedLoginCount + 1`) | integration | **RED**, 4 tests |
| Not-locked predicate neutralised (`lte: now + 24h`) | integration | **RED**, `does not count attempts that arrive in parallel WITH the locking one` |

Both mutations left the **unit** lane green, correctly — there is no database there to hold a row
lock, and `identity-fakes.ts` says so in its own comment.

**The caveat: the remaining race is real, deterministic, and larger than the implementer described.**
`fixes.md` §7.3 reports that "a correct password fired in parallel with the burst that locks the
account can still be admitted". Measured, seeding the account at four failures and firing
`[WRONG, CORRECT, WRONG, WRONG, WRONG]` in one `Promise.all`, four runs out of four:

```
PROBE-C run0 statuses=401,200,401,401,401  admitted200=1  count=1  locked=false
PROBE-C run1 statuses=401,200,401,401,401  admitted200=1  count=1  locked=false
PROBE-C run2 statuses=401,200,401,401,401  admitted200=1  count=1  locked=false
PROBE-C run3 statuses=401,200,401,401,401  admitted200=1  count=1  locked=false
```

The correct password is admitted **and** the success path's absolute write
(`{ failedLoginCount: 0, lockedUntil: null, lastLoginAt }`) **erases the lock a sibling transaction
had already committed**, leaving the account unlocked at count 1 — after the `ACCOUNT_LOCKED` audit
row and the burst notice have gone out. The table and the mailbox now describe a lock that does not
exist.

Assessment: **not a reopening of H1.** Reaching it requires the correct password, and an attacker
who has the password does not need the ladder defeated. The brute-force control — which is what §7
is about, and what H1 was about — engages correctly against every access pattern I could construct
without the credential. It is graded below as a Low, because the docblock written to explain the
fix denies it (N-3), and because nothing tests it.

### H2 — attacker-chosen text in a notice. **CLOSED WITH A CAVEAT.**

**No notice renders a user agent.** Driven through the real application with the review's own
payload as the `User-Agent`:

```
PROBE-H2 status=200  sent=newDeviceSignIn
IP address: 127.0.0.1        (the whole context block; no `Device:` line)
PROBE-H2 evil-in-text=false  evil-in-html=false  href=false
```

**The `renderableIpAddress` enforcement holds.** I attacked it with seventeen payloads against the
built module. Everything that could carry a sentence, a scheme, markup or a header break is
refused:

```
plain url            → "IP address: not recorded"
bare hostname        → "IP address: not recorded"
<b>x</b>             → "IP address: not recorded"
"><script>…          → "IP address: not recorded"
1.2.3.4\nDevice: …   → "IP address: not recorded"
1.2.3.4\r\nIP addr…  → "IP address: not recorded"
1.2.3.4\tclick http… → "IP address: not recorded"
a@b.cd               → "IP address: not recorded"
unicode full-stops   → "IP address: not recorded"
46 hex characters    → "IP address: not recorded"
```

And it is protected: removing the guard (`return value;`) turns `registry.spec.ts` **RED on five
tests**, including ruling 70's newly-widened block over `newDeviceSignIn`. Reinstating a `Device:`
line in `whereAndWhen` turns it RED on five more, and dropping the `IP address:` line turns
`login.service.spec.ts`'s two-sided assertion RED. The new tests are not vacuous — the "renders no
device string" block is more useful than its own comment claims for it.

**No fifth channel exists in shipped code.** I enumerated all nine templates and every method on
`AuthMailer`. There are exactly four: `sendVerification`, `sendRegistrationAttempt`,
`sendNewDeviceSignIn`, `sendFailedLoginBurst`. `passwordChanged`, `mfaEnabled`, `mfaDisabled`,
`passwordReset` and `invitation` have **no mailer method at all** — a stronger fact than the grep
`fixes.md` offers for them, and one that cannot be undone by editing a service. `invitation` is the
one template that will eventually render two strings a *different* person chose (`inviterName`,
`organizationName`) into a message with a link already in it; it is Task 12's, and nothing this
round did makes it worse. Attacker text also reaches `PlatformAuditEvent.userAgent`, which is
correct and is read by nobody today.

**The three notices left greeting by display name: the judgement is sound, and this is not a High
left on the branch.** Measured against the built module — `recipientName` as a URL still produces a
link in all three (`link:true`), and markup is escaped (`<img` absent from the HTML). But no caller
can exist: there is no `AuthMailer` method to call. The residual is asserted from both sides, and
the "every field except the name" half goes red the moment the IP guard is removed, so it is not
the one-sided fixture that let H2 through. Refusing to widen into Tasks 10 and 11 was the right
call.

**The caveat: H2's repeatability leg is not closed.** Familiarity is still exact-match on
`(userId, ip, userAgent)`. Measured: five successive logins with five distinct user agents produced
**five** `newDeviceSignIn` notices. The content is now benign, but an attacker holding the password
can post branded mail at the victim at the limiter's rate indefinitely — which is precisely the
"outbound-email amplifier aimed at the victim" that `failedLoginBurst`'s docblock and
`security/authentication.md` §7 rule out for the other notice. Graded Low below (N-5).

### M1 — the "NOT OPTIONAL" tenant transaction. **CLOSED WITH A CAVEAT.**

I applied mutation B myself — `withTenantTransaction(base, organizationId, …)` replaced by
`base.organization.findUnique(…)`:

```
M-4 INTEG EXIT=1
× GET /auth/session > resolves through activeOrganizationLookup OVER THE LEAST-PRIVILEGED ROLE — M1
  → expected null to deeply equal { …(3) }
AssertionError: expected null to deeply equal { …(3) }
```

The mutation that survived both lanes before now fails, with exactly the message `fixes.md` reports
and exactly the `null` the docblock predicts. Reverted; `git diff` on that file empty.

**The caveat, and the docblock now words it correctly:** the test drives the *function* over
`appPrisma`. The application under integration test still receives the owner client
(`auth-harness.ts`, `.overrideProvider(PRISMA).useValue(prisma)`), so a regression in *which* client
`auth.module.ts:129` hands `activeOrganizationLookup` would still not be caught. That is narrower
than "the lookup is protected in production", and it is the right narrowing to have made.

### M2 — the unaudited denial. **CLOSED.**

Independent probe, correct password against a `DISABLED` account through the real endpoint:

```
PROBE-M2 status=403  rows before=1  after=2
         last={"userStatus":"DISABLED","knownAccount":true,"passwordAccepted":true}
         ua=PROBE-UA/1.0 https://evil.example/x
```

The row lands in the real append-only table, names the status, records that the password was
accepted, and carries the attacker's user agent — which is where it belongs. Removing the
`recordStatusDenial` call turns **both** lanes red (2 unit tests, 2 integration tests).

Transaction boundary against `CLAUDE.md` rule 10: there is no state change, so there is nothing for
the event to be atomic *with*; the event is written inside `store.$transaction` alone because
`PlatformAuditService.record` takes a handle and never opens its own. A unit test asserts the
transaction carries nothing else and the counter is untouched, and it goes red under the mutation.
Correct.

### M3 — the burst notice inside the request. **CLOSED as accepted and named.**

No code changed, as directed. Verified in all three places: `security/authentication.md` §2's
residual list now reads "Three residuals, all open" and carries the SMTP-round-trip bullet with
both bounds; §7's burst-notice section says outright that the byte-comparison apparatus cannot see
this because the difference is in the wall clock; `fixes.md` §4. I did not re-measure it against a
real relay for the same reason the first reviewer could not — the harness substitutes an in-memory
mailer.

### L1 — the citation to a spec that does not exist. **CLOSED.**

`grep -rn "auth.session.integration.spec" apps/api/src` returns one line: the sentence that names it
as the former error.

### L2 — the docblock quoting code that was never written. **CLOSED.**

The comment and `if (origin !== undefined && origin !== this.webOrigin)` now agree, and the
repeated-header reasoning that was the point is kept.

### L3 — the `@deprecated` export kept for readers that do not exist. **CLOSED.**

`grep -rn "TASK_8_RATE_LIMIT_CLASSES"` over `apps/api/src`, `packages` and `scripts` returns
nothing.

### L4 — the two report citations. **CLOSED.**

Both halves verified independently. `auth.enumeration.integration.spec.ts`'s login lock test seeds
`{ failedLoginCount: 5, lockedUntil: <future> }` at line 325 and never sets `User.status` (the one
`status: 'LOCKED'` seed in that file, line 190, is in the resend block). `progress.md:232-235`:
ruling 37 is about `TokenService.consume` and binds **Tasks 8, 10 and 15**. The corrected paragraph
says both correctly, and volunteers that this section missed M2.

### L5 — the three false things told to a disabled user. **CLOSED WITH A CAVEAT.**

The message is rewritten, is true of both kinds of lock, distinguishes neither, and the OpenAPI
description was regenerated (`check:openapi` exit 0, ten routes, byte-identical).

Two caveats:

1. **`.claude/api/authentication.md` §6 — the document the review named — still carries the
   sentence.** Line 221-222: *"It tells the real user the one thing they need — that their password
   is fine and the account is **temporarily** unavailable."* Two lines below it: *"Both kinds of
   lock answer with it: … and `User.status = LOCKED`/`DISABLED`, the separate administrative one."*
   The code no longer says "temporarily"; this document still does. See N-1's family.
2. **Nothing observes the message.** I reverted it to the old false string and ran the entire unit
   lane plus `auth.login.integration.spec.ts` and `auth.enumeration.integration.spec.ts`: **exit 0
   in both.** The fix is correct and unprotected; the next edit reintroduces the lie silently.

### L6 — the route count. **CLOSED.** Six on the controller, ten in the product, and the docblock
now distinguishes them.

### L7 — the lockout bound presented as a prohibition. **CLOSED WITH A CAVEAT.**

`security/authentication.md` §7 gains "The per-IP window BOUNDS this; it does not prevent it" with
the arithmetic, and `abuse-prevention.md` §1 gains the paragraph that stops presenting independence
as settling it. Both are well written.

**But the disposition named two documents and one was not touched.** `.claude/api/authentication.md`
§7 (line 252-260) still ends: *"one attacker behind one address must not lock out a whole tenant by
naming their accounts in turn. **Both directions are asserted through the real application.**"* That
is the exact sentence L7 was filed against — the claim that the tests assert a property they do not
assert — surviving in one of the two files the fix brief listed by name.

---

## 3. New defects the fix round introduced or left

**Nothing at High.** I looked for a fifth channel for attacker text and could not build one: every
template that would carry it has no mailer method, and the one live context block is enforced rather
than asserted.

### N-1 (Medium) — ruling 63's carve-out is still standing in `progress.md`, and the disposition ordered it withdrawn there

`git diff --stat 629f28d..cac6372 -- docs/superpowers/` touches `task-09/fixes.md` and
`task-09/report.md` only. **`progress.md` is untouched and the last ruling is still 70.** Ruling 63
therefore still reads, unchanged, in the register every later task consults:

> *the other four templates legitimately render a device string because there it describes the
> recipient's **own** session, and `registry.spec.ts` partitions the two kinds so a new template
> must choose a side. **Binds every later notice.***

Both clauses are now false. No template renders a device string; the partition no longer means what
that sentence says it means.

The fix brief's H2 disposition is explicit: *"This supersedes ruling 63's carve-out, and that is a
deliberate act to be recorded as such. … Write it as a Task 9 ruling that names 63 and says what
changed."* The precedent exists in this repository — Task 8's own fix round added ruling 70 to
`progress.md` in commit `47f59f6`, in the fix commit. `fixes.md`'s H2 row asserts "Supersedes ruling
63's carve-out" without saying where, and §3 reports the one unpredicted finding while not reporting
this omission.

**Why Medium rather than Low.** The code on this branch is correct. The mechanism that produced
this same defect three times in three tasks is not the code — it is a written rule with an
exception, and a Task 10 or Task 11 implementer reading `progress.md` will find that exception
intact, marked *binds every later notice*, with a supersession recorded only in a docblock and a
`.claude/` section they have no reason to open. The withdrawal was the durable half of the H2
disposition and it is the half that did not ship.

### N-2 (Low) — four sentences in the two files H2 rewrote still describe the user agent as rendered

This is L2's class, introduced while fixing L2.

1. **`notice.templates.ts:329-334`**, the docblock immediately above `NewDeviceSignInContext` — the
   type H2 narrowed: *"**The IP and the user agent stay**, and that is ruling 63's licensed side of
   the partition: … the device string is exactly how they recognise one that is not theirs. Both
   still pass through `escapeHtml` … and the residual `registry.spec.ts` records for the
   context-rendering notices applies here unchanged."* Every clause is false after H2, and the
   residual block it cites was deleted in the same commit.
2. **`notice.templates.ts:22-24`**, the file docblock: *"`ipAddress` comes from the connection and
   `userAgent` is a request header the client chooses outright, so both reach `escapeHtml` like
   everything else."*
3. **`notice.templates.ts:291`**: *"NOT `whereAndWhen(context)`, which is the other four notices'
   block and carries the caller's IP and user agent."*
4. **`registry.spec.ts:152-155`**: *"The IP and the user agent are still passed and still escaped,
   because there they describe the recipient's own session."* The correcting comment was appended
   directly below it rather than replacing it, so the file now states both.

Five of this project's historical false claims were introduced while correcting an earlier one;
these are four more, in the file whose subject is the correction.

### N-3 (Low) — the success path's docblock denies the race the implementer reported

`identity.store.ts`, third union arm: *"An absolute value is correct **here and nowhere else on the
login path**: a successful login sets the counter to a constant rather than deriving it from a value
it read earlier, so there is nothing for a concurrent request to make stale."*

Measured false, four runs out of four (PROBE-C above). What is stale is not the constant but the
**decision** to write it, taken from the same pre-hash `isLocked` read that caused H1 — and the
consequence is that `lockedUntil: null` overwrites a lock another transaction committed. Carry-forward
ruling 22's shape, in the file rewritten to close H1. The code is defensible; the sentence beside it
is not, and nothing tests the path.

### N-4 (Low) — `IP_LITERAL` admits bare autolinkable hostnames

`^[0-9a-fA-F.:]{3,45}$` accepts any string of hex letters, dots and colons, so:

```
dead.beef.cafe  → "IP address: dead.beef.cafe"
facade.de       → "IP address: facade.de"
abcdef.cc       → "IP address: abcdef.cc"
```

`.de`, `.cc`, `.cafe` are real TLDs and many mail clients autolink a bare domain. The docblock's
claim is that the check must "make it impossible for this line to carry a sentence, a URL, or
markup"; it achieves the sentence and the markup exactly, and the URL with a small gap the suite
cannot see (its assertion is `https?://`). **Not reachable today** — `request.ip` is the socket peer
with `trust proxy` disabled, verified in `request-context.ts` and by grep — so this costs nothing
until the day a deployment enables `trust proxy`, which is the day the whole reason for keeping the
line changes. Worth a character-class narrowing (`[0-9a-fA-F]` requires at least one digit, or a
`.`-segment length rule) or a sentence recording the gap.

### N-5 (Low) — H2's repeatability leg is not closed

Measured: five logins, five distinct `User-Agent` values, **five** `newDeviceSignIn` notices to the
victim. The disposition addressed the notice's *content* and not its *trigger*. Content is now
benign, so this is mailbox flooding and alert fatigue rather than phishing — but it is the same
property `security/authentication.md` §7 and `failedLoginBurst`'s docblock refuse to accept one
template over, and it is not named anywhere.

---

## 4. Measurements, for a later reader

### 4.1 Mutations applied, run and reverted

| # | Mutation | Suite | Result |
|---|---|---|---|
| M-1 | `renderableIpAddress` returns the value unguarded | unit, registry | **RED**, 5 tests |
| M-2 | not-locked predicate neutralised | integration | **RED**, the parallel-with-the-lock test |
| M-3 | `recordStatusDenial` call removed | unit + integration | **RED**, 2 + 2 |
| M-4 | mutation B: `withTenantTransaction` removed | integration | **RED**, `expected null to deeply equal { …(3) }` |
| M-5 | ladder computed from the stale pre-hash read | integration | **RED**, 4 tests |
| M-6 | `AccountLockedError` message reverted to the false one | unit + 2 integration specs | **GREEN — survived** → L5's caveat |
| G-1 | a hardcoded `Device:` line returns to `whereAndWhen` | unit | **RED**, 5 tests |
| G-2 | the `IP address:` line dropped | unit | **RED**, the two-sided IP assertion |
| F-1 | the **fake**'s `updateMany` ignores the predicate | unit, whole lane | **GREEN — survived** |

F-1 is recorded rather than graded. `identity-fakes.ts` models the predicate and no unit test
observes that it does; the fake's own comment says the integration lane owns the property and
nothing in the file may be read as evidence for it, which is honest. It is noted so a later reader
does not count that branch as coverage.

### 4.2 Citations re-verified

- `grep -rn "auth.session.integration.spec" apps/api/src` → one line, the correction itself.
- `grep -rn "TASK_8_RATE_LIMIT_CLASSES"` over src, packages, scripts → nothing.
- `grep -rn "sendPasswordChanged\|sendMfaEnabled\|sendMfaDisabled" apps/api/src` → one line, the
  comment that states the grep. Stronger than claimed: `AuthMailer` has no such method.
- `progress.md` ruling 37 → `TokenService.consume`, binds Tasks 8, 10 and 15. As corrected.
- `progress.md` ruling 63 → still carries the carve-out (N-1).
- `progress.md` ruling 66 → says what the round cites it for.
- `auth.enumeration.integration.spec.ts:325` → seeds the brute-force lock only. As corrected.

---

## 5. What I could not check

- **The SMTP half of M3**, for the same reason the first reviewer could not: the harness substitutes
  an in-memory mailer. The residual is now named in three places and I verified the sentences, not
  the milliseconds.
- **Whether a mail client autolinks `facade.de`** (N-4). I measured what the template renders, not
  what Gmail or Outlook do with it.
- **`pnpm test:e2e`**, correctly — no `apps/web` path is touched by this range.
- **The M1 test against the wired application.** The harness still hands the API the owner client,
  so I could confirm the lookup works over `sentinel_app` but not that production's wiring passes it
  that client.

---

## 6. What I did not find

- No fifth channel for attacker-chosen text into a message reaching somebody who did not choose it.
  Every remaining carrier is a template with no mailer method.
- No High. No cross-tenant gap (nothing in range is tenant-owned; `check:registry` unchanged at
  15/3/1/11). No secret in an audit row, a log line or an email body. No `AuditEvent` where ruling
  62 requires a `PlatformAuditEvent`. No regression in the eleven-command gate.
- No test in this round that observes a different refusal than the one it names: every new
  assertion I mutated against went red for its own stated reason, with the two documented
  exceptions above (the M1 negative arm and the fake's predicate branch, both of which the round
  names as such).
