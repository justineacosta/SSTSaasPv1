# Task 10 — Redis sliding-window rate limiting: reports

Commits: `58921e2..6b15c2c` — implementation `ab44082`, then three fix rounds: `3606842`,
`4ec76a0`, `6b15c2c`. Three adversarial reviews, each of which found real defects in the round
before it.
Status: **substantively complete; one review round short of formally closed.** Round 4's fixes
(`4ec76a0..6b15c2c`) have not themselves been reviewed. Round budget: 4 of 5.

**Provenance note, and it matters for how much these reports are worth.** Tasks 1–9 were built by
fresh implementer subagents and reviewed by separate adversarial ones. Task 10 was hit by a weekly
usage limit during the implementer's orientation reads (18 tool calls, no writes), so **the
controller implemented it directly**, and then also chose the rulings it implemented against. The
reviews below are the only independent eyes this task has had — and both of them found real defects
in the controller's work, including two Criticals and one fix that opened a new hole.

---

## Round 1 — implementation (`ab44082`), controller-authored

TDD held: the config spec was written first and failed on module-not-found before the config
existed. Eight mutations were run against the finished code; all eight caught.

### Overruled the plan on the core primitive
The plan specified a `MULTI` doing `ZREMRANGEBYSCORE` / `ZCARD` / `ZADD` / `EXPIRE`. **A `MULTI`
cannot do this correctly** — whether to `ZADD` depends on the `ZCARD` result, and a transaction
cannot branch on a command inside it. Both writable shapes are wrong:

- **Add unconditionally** → a refused request is charged against its own window, so a client
  hammering a closed door pushes it forward with every knock and never sees it open.
- **Read, then write in a second round trip** → two concurrent requests both see room, which is the
  exact race the plan's own rationale invokes the transaction to prevent.

Shipped one Lua script: atomic against a single-threaded server, one round trip, able to branch.
**Both `MULTI` shapes were implemented as mutations and both redden tests** (M2, M4).

### Two properties added that were not in the plan
- **A forged `X-Forwarded-For` must not mint a fresh bucket.** If the header were trusted, rotating
  it would defeat per-IP limiting entirely. Proven by M5: enabling `trust proxy` reddens the test.
  Documented that a real load balancer needs more than that flag — the proxy must **overwrite** the
  header, not append, or the bypass returns through the front door.
- **Unique sorted-set members.** M1: making the member the timestamp reddens 4 tests, because `ZADD`
  would overwrite rather than add and silently double the effective limit.

### Ruling made in advance, then proven
An unresolvable scope is **not** a free pass: if a class declares scopes and none resolve, `failMode`
applies. Without it `invitations` and `scanCreate` — keyed *only* `perOrganization`, with no tenant
context before Phase 2 — would carry no limit at all despite being fail-closed. M8 (the naive "skip
unresolvable scopes" implementation) returns 201 where the shipped code returns 429.

Refined during implementation: log at `warn` only when the outcome is a refusal, at `debug` when
fail-open — an unauthenticated request to a `perPrincipal` class is the *normal* state of every
request until Phase 2, and a warn per request would be a flood that trains operators to ignore the
channel.

### Other deviations
- **Fixture routes live in the spec**, not as `__test` routes behind an `APP_ENV` check, following
  Task 9's `BoomController` pattern: a route that exists only in a test file cannot ship and cannot
  be reached by a misconfigured environment. Ruling F7 still honoured — they carry `@Public()`.
- **One row of `abuse-prevention.md` §1 deliberately omitted:** webhook test delivery is 10/hour
  **per endpoint**, a scope nothing can resolve until Phase 9. Keying it against the wrong scope
  would *look* enforced. *(This argument is the one the reviewer later turned back on the
  controller — see C1.)*

### Mutations, all 8 caught
M1 timestamp member (4 red) · M2 `count <= limit` off-by-one (6 red) · M3 reset from `now` (1 red) ·
M4 unconditional `ZADD`, i.e. the plan's `MULTI` (2 red) · M5 `trust proxy` on (1 red) ·
M6 `registration` fail-open (1 red) · M7 `generalSession` fail-closed (2 red) · M8 skip unresolvable
scopes (1 red, 201 vs 429).

**Gates:** `turbo --force` 18/18 uncached, 202 unit, 123 integration, tree clean.

---

## Round 1 — review: **findings remain** (2 Critical, 3 Important, 9 Minor)

The reviewer verified ten claims by measurement, ran ten independent mutations (all red — "8 caught"
was, in its words, understated), and confirmed the Lua-over-`MULTI` argument. Verified as claimed:
`limit=1` and `limit=0` edges; `tostring()` float precision a non-issue; `PEXPIRE` bounds memory
(`pttl=59999` after a refusal); `X-Real-IP` and `Forwarded` also ignored; liveness reached **zero**
Redis commands under `MONITOR`; headers survive the throw with correct values; all 12 table numbers
match; no IPs, principals or bodies logged (a `redis://…hunter2…@` URL produced 0 occurrences).

### C1 — `perPrincipal` cannot key the three per-*account* rows, and the guard hides it silently
`rate-limit.guard.ts:56`. Login, password reset and email-verification-resend are **unauthenticated
by definition** — a *failed* login never carries a principal, and the account being attempted lives
in the request body.

```
D: 6th unauthenticated login status = 201  RateLimit-Limit = 20  Remaining = 14
D: keys = [ 'ratelimit:login:perIp:::ffff:127.0.0.1' ]   ← no perPrincipal key at all
```

Because `perIp` *does* resolve, `decisions.length > 0`, so the unresolved scope was skipped with **no
failMode, no log, no header, no test**. The route looks limited and does not apply the control that
stops credential stuffing.

> The reviewer's framing, recorded verbatim because it is the lesson: *"This is precisely the 'would
> look enforced without being so' failure the controller invoked to justify omitting the webhook
> row, committed here for three of ten rows."*

### C2 — a request refused by one scope is still charged against the other
`rate-limit.guard.ts:96–120`.

```
20 requests, 20 distinct principals  → per-IP window (20/15min) exhausted
6 requests naming "victim"           → all 429 (refused by IP)
zcard ratelimit:login:perPrincipal:victim = 5   (expected 0)
```

One IP, *after* its own limit closed, locks out arbitrarily many accounts — the per-IP cap no longer
bounds the damage a single IP can do, which is the stated purpose of having both scopes. It also
contradicts the property the commit message and `abuse-prevention.md` both assert.

### Importants
- **I1** `roadmap.md` still said "no rate limiting" while `backend.md` said Implemented — a
  `CLAUDE.md` violation (same-change rule).
- **I2** Liveness stays Redis-free **only by coincidence**. The reviewer planted the most plausible
  future change — adding `perIp` to `generalSession`, which §1's own rationale arguably demands —
  and **the entire suite stayed green** while `/health/live` began issuing an `EVAL` per probe and
  its latency climbed **0.22 s → 0.98 s → 1.80 s** during an outage, past a 1 s probe timeout.
- **I3** Neither the partial-resolution case nor cross-scope charging had any test.

### Minors
`tightest` tie-break understates `Retry-After` when two scopes are exhausted · no IP normalisation
(`::ffff:1.2.3.4` vs `1.2.3.4`) · forward clock skew causes a lockout of the *skew* duration, not
"immaterial" as the docblock said · full `EVAL` (~730 bytes) on every request, no `EVALSHA`, scopes
awaited serially · unbounded warn volume during an outage · Redis `maxmemory 0` / `noeviction` and
compose sets neither · the suite `DEL`s every `ratelimit:*` key in the shared dev Redis via a
blocking `KEYS` · `RateLimit-*` headers absent on the fail-open unresolvable path, meaning **no
shipped route is rate limited today** · unrouted requests bypass the guard entirely.

---

## Round 2 — fix report (`3606842`), controller-authored

Both Criticals fixed properly rather than narrowly. C1 needed a per-class principal source (config
gained `principalSource: 'authenticated' | { bodyField }`), with the body value **hashed** before
entering a key — a raw email in a Redis key is visible to `KEYS`, the slow-log and a memory dump.
C2 is a `break` on first refusal.

I2 was fixed **structurally**, not by test alone: `@RateLimitExempt()`, used only on liveness, plus a
test watching a live `MONITOR` connection for zero commands.

### Mutation discipline failure, caught in flight
The first attempt at the C2 mutation **reported all 19 tests passing** — because the `perl`
substitution silently did not apply. **A mutation that cannot mutate is the same defect as a test
that cannot fail, and it produces the more dangerous artefact: false confidence in a test that was
never exercised.** Re-applied with an assertion, it reddens with `expected 5 to be 1`.

**Standing rule adopted:** every mutation must assert the file actually changed before the suite runs.

Minors also fixed: `Retry-After` takes the longest reset among refusals; IPv4-mapped IPv6 normalised
with a unit spec; `resetSeconds` clamped to the window with the docblock corrected; outage logging
moved to state-change; the suite `SCAN`s only its own classes' keys; `roadmap.md` and
`abuse-prevention.md` rewritten to say the limiter governs nothing today.

**Deferred, recorded:** `EVALSHA`/pipelining and Redis `maxmemory-policy`. Both performance/ops,
neither a correctness or security defect.

---

## Round 2 — re-review: **findings remain** (1 Critical, 5 Important, 8 Minor)

The two headline fixes **held** — M3 (`break`), M4 (`principalSource`), M5 (hashing) and M8 (scope
order) all went red. Every mutation was proven applied via `git diff` before the suite ran.

> **The lesson of this round:** the damage was concentrated entirely in the four smaller "also"
> changes, which were written with less care than the two under scrutiny. In a fix round, the
> incidental changes are the dangerous ones, because attention is on the headline finding.

### C-1 — the fix turned `emailVerificationResend` from "refuses everything" into "no bound at all"
`rate-limit.config.ts:73-77`. That class declares `perPrincipal` and **no `perIp`**. Before the fix,
the principal never resolved, so fail-closed refused everything. After it, every request naming a
fresh address is the first in its own window:

```
RESEND allowed=60/60 keysCreated=60 ttlSeconds=3600
```

Sixty requests from one loopback address, all 201, sixty zsets pinned for an hour. In Phase 2 this
is an unauthenticated outbound-email amplifier aimed at third-party addresses — the "protect people
who are not our customers" case the document opens with — plus unbounded Redis growth.

### Importants
- **I-1** `backendDown` logged "recovered" while Redis was still dead, **deterministically**: the
  reset sat after the `try`, so it fired on requests that issued no Redis command at all (most
  traffic today). Measured flapping. *Strictly worse than the per-request warn it replaced — a false
  all-clear closes incidents that are open.*
- **I-2** Deleting `@RateLimitExempt()` from liveness left **the entire suite green**; so did making
  the guard read only `getClass()`. Both liveness tests asserted a property that held for the
  accidental reason, and the `MONITOR` test had **no positive control**.
- **I-3** `principalSource` was optional with a comment saying "required"; a planted `perPrincipal`
  class with no source compiled cleanly (`TSC_EXIT=0`). MFA verify, magic links and phone OTP are all
  Phase 2 classes of exactly that shape.
- **I-4** Class-level `@RateLimitExempt()` silently overrode explicit per-handler `@RateLimit()` — a
  one-line kill switch for the platform's only abuse control, with no way to opt back in.
- **I-5** C1's *silence* was narrowed, not fixed: an unresolvable body field still skipped the account
  limit with no log and no header. Measured across 12 body shapes; `{"email":["a","b"]}` and
  form-encoded duplicates are attacker-chosen shapes that remove the account limit at the guard.

### Minors
`tightest`'s refused tie-break is **dead code** (the `break` guarantees at most one refusal) and the
property it claimed measurably does not hold · the clamp was untested and the docblock called the
clamped number "honest" when a 4500 s lockout is reported as 900 · `normaliseIp` unit-tested but its
call site not · the digest is unsalted (a confirmation oracle) and truncated · NFC/NFD produce two
buckets · **three false documentation statements** · body-parse failures are a second unmetered path
· the cleanup comment overstates what the narrowing buys.

---

## Round 3 — fix report (`4ec76a0`), controller-authored

All of C-1, I-1…I-5 and the eight Minors, in one round.

- **C-1:** `emailVerificationResend` gains `perIp: 10/hour`. §1's *table* names only the per-account
  figure, but §1's *opening sentence* says limits apply per IP **and** per principal — the table's
  rows are figures, not the rule. The figure matches password reset, the closest analogue.
  *Cost if wrong: this number is invented rather than transcribed, and is documented as such in both
  the table and the config.*
- **I-3:** `principalSource` became a discriminated union — a compile error, verified by planting a
  `perPrincipal` class with no source.
- **I-4:** exemption narrowed to `MethodDecorator`.
- **N-1:** the dead tie-break branch removed and the limitation written down rather than
  half-solved — a client refused by a nearly-expired IP window can obey `Retry-After`, arrive, and be
  refused again by an account window it never reached. Fixing that properly means evaluating all
  scopes read-only and committing only if all allow, which also changes what "charged" means.
  Recorded, not half-built.

**A mutation harness was built** (`scratchpad/mutate.py`): it asserts the pattern exists and exits 1
if not, so a mutation can no longer silently fail and report a false "caught". Every mutation below
ran through it.

**Newly caught, all previously green:** N1 delete the liveness exemption · N2 drop resend's `perIp` ·
N3 delete the `normaliseIp` call site · P1 truncate the digest to 4 chars · P3 exemption lookup
ignores the handler. The clamp now has a test.

The digest is **pinned by value**, which catches both a truncation and a per-process salt in one
assertion — and a salt is a security defect dressed as hardening: it splits one account's window
across instances and multiplies the effective limit by the instance count.

**Three false documentation statements corrected:** a property count that no longer matched its
bullets; a sentence claiming all three per-account classes carry a `perIp` scope when the one being
fixed did not; and "nothing is governed because no identifier resolves", which is wrong —
`registration` is keyed per IP and resolves today. The right reason is that no **route** carries a
limit class.

**Gates:** `turbo --force` 18/18 uncached, 219 unit, 128 integration, tree clean.

---

## Outstanding (as at round 3 — superseded by the sections below)

A third scoped re-review of `3606842..4ec76a0` was owed. It ran; see below.

---

## Round 3 — re-review: **findings remain** (0 Critical, 4 Important, 6 Minor)

24 mutations, each verified *applied* before running — **which caught 5 false "caught" results**:
the reviewer's first union/decorator batch reported RED from a Prisma `EPERM`, not a type error.
Independent confirmation that the harness rule adopted last round was necessary.

**Held up:** C-1 works (12 fresh addresses → `201×10, 429, 429`, exactly 10 `perPrincipal` keys, so
the `break` stopped 11–12 before they spent account budget); the account window is **not** dead
config (same address → `201,201,201,429` at `RateLimit-Limit: 3`); I-3 is enforced by the type in
the config file itself, and four different evasions all fail `tsc`; I-4 as a class decorator is a
real compile error; N-1's deleted branch really was unreachable; all three of round 2's
"untestable" guarantees now redden; the body-parse doc claim is true with a positive control.

### Important
1. **The I-5 warn is per-request and attacker-triggerable** — 5 POSTs without `email` produced 5
   warns. The guard's own documented anti-pattern, thirty lines from where the sibling branch
   argues against it. No test (replacing the condition with `false` left both suites green).
2. **`tightest()`'s tie-break is completely untested.** Reporting the *loosest* window survived both
   suites; measured, an allowed login would advertise `20 / 19` when the client actually has 4 left.
3. **The class-level kill switch I-4 claims to have closed is still fully open.** Narrowing the
   helper's type did nothing to the guard, which still read `context.getClass()`. Demonstrated:
   `@SetMetadata(RATE_LIMIT_EXEMPT_KEY, true)` on a controller → **6/6 × 201 during a Redis outage
   on a fail-closed class.**
4. **Per-IP keying is per full IPv6 address**, so C-1's bound is IPv4-only — a routed /64 gives
   ~1.8×10¹⁹ buckets. Pre-existing, but *newly load-bearing*, since C-1's whole justification is
   that per-IP bounds the amplifier. (The reviewer worked the numbers and judged 10/hour defensible
   over IPv4: targeted harassment stays bounded at 3/hr by the account window, so the figure governs
   breadth.)

### Minor
NFKC unpinned (switching to NFC survived) · NFKC over-merges (fullwidth, ligatures, `℡`, `①`) and
`normaliseAccountIdentifier` lives in the guard rather than a shared package · I-1 defers the
recovery line indefinitely and a second outage logs nothing · **one documentation "correction"
landed ungrammatical** — a dangling clause mid-sentence · a fixture comment C-1 falsified · the
transcription test skips the row this round added.

*Not in the commit message:* `resolveIdentifier` was widened to `export`.

### On the round's own hypothesis
> *"It reproduced, and more sharply than last round. Every finding above except #3 and #4 is in an
> 'also' item or in a fix that shipped with no test at all. A round whose stated purpose was 'make
> three guarantees testable' shipped three new behaviours and tested none of them."*

---

## Round 4 — fix (`6b15c2c`), controller-authored

All four Importants and all six Minors.

- **#3** the guard now reads `this.reflector.get(KEY, context.getHandler())` — the handler alone.
- **#1** the warn is once per class per process, via an instance `Set`.
- **#2** a multi-scope allowed-path header test.
- **#4** IPv6 bucketed by /64, with `::` expanded properly rather than read off the literal text.
- **#5/#6** NFKC pinned in both directions — fullwidth and ligature forms must fold, Turkish dotless
  ı and ZWSP must not.
- **#7** the `backendDown` docblock now states what the flag means and what it costs.
- **#8/#9/#10** the broken sentence, the stale fixture comment, the missing transcription row.

**A second decorative test caught in the act.** The flood test first captured stdout — and the test
environment's logger deliberately writes nowhere, so it passed whether the guard warned once or six
times. Replaced with an injected recording logger via `overrideProvider(LOGGER)`; it now fails in
both directions (`expected 6 to be 1` and `expected +0 to be 1`).

Mutations, all applied-asserted and all red: R1 restore class-level exempt lookup · R2 warn every
request · R3 report the loosest window · R4 never warn. Two pre-existing IPv6 assertions encoded the
full-address rule and were updated to the /64 rule.

**Gates:** `turbo --force` 18/18 uncached, **226 unit, 131 integration**, tree clean.

**Round budget:** 4 of 5. Deferred and still open: `EVALSHA`/pipelining, Redis `maxmemory-policy`,
and moving `normaliseAccountIdentifier` into a shared package before Phase 2's account lookup needs
to import it.

---

## Round 5 — closing review of `4ec76a0..6b15c2c`: **no Critical, 2 Important, 5 Minor**

12 mutations, each substitution asserted applied before running — **the harness rejected one of the
reviewer's own attempts as not-applied**, which is why it trusted the rest. 11 of 12 caught.

**Verified holding:** the bypass is genuinely closed, probed via two routes nobody had tried —
**inheritance** from a base class carrying the metadata, and a **mixin** that stamps it — both
correctly limited. Liveness still issues zero Redis commands with the positive control passing.
`unresolvedWarned` is bounded and not attacker-influenced. The flood test does not leak
(`connected_clients` 1 → 1). The pinned digest was independently recomputed and matches. And
`expandIpv6Prefix` survived a **768,001-case differential fuzz** across compressed, full,
zero-padded and uppercase spellings of 199,058 distinct /64s: **0 splits, 0 collisions, 0 throws**.

### I-1 — the warn is keyed by class alone, so ordinary traffic silences a real defect
Reproduced with a direct guard probe: `login` with an empty body warns `['perPrincipal']`; a second
call with a valid email but **no `req.ip`** — per-IP limiting silently off, exactly what the warning
exists to surface — produced **no warn at all**. The first miss is free for any unauthenticated
caller to trigger within seconds of boot, and it burns the class's only warning for the life of the
process.

### I-2 — the /64 bucketing is shipped, security-relevant, and undocumented
`grep` for `/64` or `IPv6` in `abuse-prevention.md` returned nothing, in a file the round-4 commit
had edited. **Root cause found while fixing it:** that edit used an unasserted string `replace` that
matched nothing and failed silently — the same failure mode the mutation harness exists to catch,
committed in a documentation edit rather than a test.

### Minor
Two IPv6 tests could not detect their own removal — one a literal tautology, one a
**mutation-verified survivor** (the zone strip is unreachable; the /64 slice discards hextets 5–8).
Third round running that a named guarantee was asserted by a test that cannot fail. Plus: an
embedded-IPv4 tail miscounted by one hextet; `host:port` treated as IPv6; a stale warn claim in the
docs; a regex accepting out-of-range octets.

---

## Round 6 — closing fixes (`02c7a45`), controller-authored

- **I-1** keyed by `class:scope`, reporting each newly-seen pair. Two unit tests drive the guard
  directly, because a real socket always has a peer address and the case cannot be reached over
  HTTP. Mutation S1 (revert to class-only) reproduces the reviewer's exact output,
  `expected [ 'perPrincipal' ] to include 'perIp'`.
- **I-2** the per-IP unit documented, with its cost stated (shared /64 neighbours share a bucket),
  plus a third trust-proxy requirement: a bare canonical address with **no port**.
- **M-1** the unreachable zone strip deleted along with both weak tests, replaced by assertions on
  the bucketing outcome — which is the property that matters and survives the strip's removal.
  Mutation S2 (`/64` → `/48`) reddens two tests.
- **M-4** folded into the I-2 edit.

**Gates:** `turbo --force` 18/18 uncached, **228 unit, 131 integration**, tree clean.

### Parked, with rulings

| Finding | Ruling |
|---|---|
| **M-2** `expandIpv6Prefix` counts an embedded IPv4 tail as one hextet, not two — `2001::1:2:3:4:192.168.0.1` collides with a different /64 | **Deferred to the `trust proxy` work.** Unreachable while `request.ip` is Node's canonical `socket.remoteAddress`, which never emits that form. Cost if wrong: two distinct /64s share a bucket, a cross-client lockout. |
| **M-3** `host:port` treated as IPv6, so `1.2.3.4:5678` gets its own bucket | **Deferred to the same work**, and now covered by the documented no-port requirement. Cost if wrong: per-IP limiting silently decorative behind a port-appending proxy. |
| **M-5** mapped-IPv4 regex accepts out-of-range octets | **No action.** Unreachable from a socket address; tightening risks rejecting a form Node does emit. |
| **EVALSHA / pipelining** | Carried to Task 14 or Phase 3. Performance, not correctness. |
| **Redis `maxmemory-policy`** | Carried to Phase 3, when BullMQ shares the instance. |
| **`normaliseAccountIdentifier` lives in the guard** | Move to a shared package in Phase 2, when the account lookup needs to import it. The docblock already names the invariant. |

---

## Task 10: CLOSED

Four adversarial reviews, five fix rounds, `58921e2..02c7a45`. Three Criticals found and fixed, two
of them introduced by fixes. The recurring lesson, which held in three consecutive rounds: **the
damage lands in the incidental changes, not the headline fix.**
