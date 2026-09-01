# Abuse prevention and rate limiting

> **Status: Rate limiting Implemented (Phase 1) and governing three endpoints since Phase 2
> Task 8.** Quotas Phase 10; anomaly detection Phase 11; the enforcement ladder in §4 Phase 11.
> The limiter is a global Nest guard — `apps/api/src/common/guards/rate-limit.guard.ts` — over a
> Redis sorted-set window in `sliding-window.ts`, with the table below transcribed into
> `rate-limit.config.ts` and that transcription asserted value by value.
>
> **Three classes are now carried by a real route**, which was not true through Task 7:
> `registration` on `POST /api/v1/auth/register`, `emailVerificationConsume` on
> `POST /api/v1/auth/verify-email`, and `emailVerificationResend` on
> `POST /api/v1/auth/resend-verification`. All three are per-IP-resolvable on an unauthenticated
> request, and `emailVerificationResend`'s per-account half resolves from the body's `email`
> field. Every other class in the table below still governs nothing, because the endpoints that
> would carry it do not exist.
>
> **The per-principal gap of §1 below is unchanged by that.** No route carries a class keyed on
> `principalSource: 'authenticated'`, and if one did the limiter would still resolve nothing —
> it runs before the authentication guard by design.

Ordinary SaaS limits abuse to protect its own capacity. We also limit it to protect people
who are not our customers. See [`scope-controls.md`](scope-controls.md) for the controls
that decide *whether* a scan may run; this document covers *how much* and *how fast*.

## 1. Rate limits

Sliding window in Redis, applied per IP **and** per principal — an attacker with many IPs
is caught by the principal limit, and an unauthenticated flood by the IP limit. Limits are
configuration, not constants, and are overridable per plan.

**The per-principal half does not resolve, and authentication arriving did not change
that.** The limiter reads `request.principalId`, and `architecture/backend.md` §3 puts the
limiter *before* the authentication guard — deliberately, so an unauthenticated flood
carrying a garbage cookie cannot buy a Redis read and a Postgres read each before anything
refuses it. Phase 2 Task 7 built the guard and left the order alone, so every
`principalSource: 'authenticated'` scope is still unresolvable — `generalSession`'s
1000/min per principal is applied to no request at all.

**Nothing reports that.** An earlier version of this paragraph said the guard's
`unresolvedWarned` warning made it visible at runtime; it does not. That warn is gated on
`unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed'`, and
`generalSession` is `failMode: 'open'` with `perPrincipal` as its only scope, so
`decisions.length` is 0 and the fail-mode test fails too. The branch that does fire logs at
**`debug`** for a fail-open class, and `LOG_LEVEL` defaults to `info`
(`packages/config/src/env.ts`) — so at the default level an unapplied rate limit produces no
log output whatever. Measured against a real boot by the Task 7 reviewer: zero lines of
"not being applied", sixteen of "could not be resolved", all at DEBUG.

The fix is to split the limiter into an early per-IP stage and a late per-principal one; it
is owed and not built, and until it lands the only way to observe the gap is to run at
`LOG_LEVEL=debug` and read for "could not be resolved".

**A per-*account* window is a different thing and it does resolve — as of Phase 2 Task 9, on
one route.** The three per-account rows in the table below are unauthenticated by definition:
"5 / 15 min per account" means the account being *attempted*, which lives in the request body,
not a principal the limiter could not have resolved anyway. `rate-limit.config.ts` expresses
that as `principalSource: { bodyField: 'email' }`, and the value is hashed before it becomes a
Redis key so an address never lands in the keyspace in plaintext.

`POST /api/v1/auth/login` is the **first shipped route on which that source has ever
resolved**. The `Login` row below is therefore live: both windows apply, and they bite
independently, which is
[`authentication.md`](authentication.md) §7's actual property rather than merely "a limit
exists". Measured through the real application: six attempts against one address from one IP
answer `401,401,401,401,401,429` while a second address from the same IP still signs in, and a
sweep across distinct addresses from one IP is refused at the twenty-first attempt.

**Independence bounds the damage; it does not prevent it.** The measurements above show the two
windows applying separately, which is what §7 asks for — but 20 attempts per 15 minutes per IP at
5 attempts per lock is four locks per window, and roughly eight accounts held permanently at the
30-minute cap from a single address. `authentication.md` §7 carries the arithmetic. Presenting the
independence as though it satisfied "one attacker cannot lock out a whole tenant" would overstate
it.

`Email verification resend` also declares a `{ bodyField: 'email' }` source and has since Task
8, but it is `3 / hour per account` on an endpoint that sends mail rather than one that checks
a credential — the per-account half there bounds an outbound-email amplifier, not credential
stuffing.

| Endpoint class | Default |
|---|---|
| Login | 5 / 15 min per account, 20 / 15 min per IP — **live on `POST /auth/login` since Task 9** |
| Registration | 3 / hour per IP |
| Password reset request | 3 / hour per address, 10 / hour per IP |
| Password reset submit | 20 / hour per IP |
| Password change | 10 / hour per IP |
| Email verification resend | 3 / hour per account, 10 / hour per IP |
| Email verification submit | 30 / hour per IP |
| Invitations | 50 / day per organisation |
| Scan creation | Per plan (`maxScansPerMonth`), plus 10 / min burst |
| Evidence upload | 100 / hour per organisation |
| Report generation | 10 / hour per organisation |
| Webhook test delivery | 10 / hour per endpoint |
| General API (session) | 1000 / min per principal |
| General API (key) | Per plan, default 600 / min |

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `429` with
`Retry-After`. Limits fail **closed** for authentication endpoints and **open** for
read-only endpoints if Redis is unavailable — an outage should not lock everyone out of
reading their own data, but it must not become a window for credential stuffing either.

Five properties of the shipped implementation are worth stating, because each is a way this
control is commonly built wrong:

- **A refused request is not charged against the window.** A limiter that records refusals
  extends its own lockout — every knock on a closed door pushes the window forward, and a
  client that keeps retrying never sees it open. The check and the write are therefore one
  Lua script rather than a `MULTI`, because a transaction cannot branch on the count it just
  read.
- **`X-Forwarded-For` is not trusted.** The per-IP identifier is Express's `request.ip` with
  `trust proxy` disabled, so it is the socket's peer address. If the header were trusted,
  rotating it would mint a fresh bucket per request and per-IP limiting would be decorative.
  Putting a load balancer in front of this API therefore requires more than enabling
  `trust proxy`. The deployment must also guarantee that the proxy **overwrites** the header
  rather than appending to it, and that it writes a **bare canonical address with no port** — a
  proxy that appends `:port`, as some do, gives every connection its own bucket and makes
  per-IP limiting decorative again.
- **The per-IP unit is an address for IPv4 and a /64 for IPv6.** A single host is routinely
  delegated a whole /64 — 1.8×10^19 addresses — so bucketing per address would make every
  per-IP figure in the table free to bypass for anyone with a v6 allocation, including the
  resend bound above. The cost of the /64 is real and worth knowing before someone debugs it:
  neighbours behind a **shared** /64, which some mobile carriers and some hosting providers hand
  out, share a bucket and can exhaust each other's. That is the same trade IPv4 NAT already
  forces, and the other side of it is no bound at all.
- **The per-account rows are keyed off the request body, not an authenticated principal.**
  Login, password reset and email verification resend are unauthenticated by definition — a
  failed login carries no principal, and "5 / 15 min per account" means the account being
  *attempted*. Reading a session principal there resolves nothing, and because those classes
  also carry a per-IP scope that *does* resolve, the miss would be skipped in silence: a route
  that refuses at the IP limit, advertises that limit in its headers, and never applies the
  control that actually stops credential stuffing. A declared scope that resolves to nothing on
  a fail-closed class logs at `warn` naming the scope — **once per class and scope per process**,
  not on every occurrence, because a client sending a body without the field is ordinary traffic
  anyone can generate, and a line per request would bury the wiring defect the warning exists to
  surface. The body value is hashed before it becomes
  part of a key, so an email address never lands in Redis in plaintext.
- **A refusal stops the evaluation.** Scopes are consumed in order and the first refusal ends
  it. Otherwise a request already being rejected would still be charged against every remaining
  window — so one address, *after* its own per-IP limit had closed, could go on burning the
  per-account budget of every account it named and lock out arbitrarily many of them. Bounding
  the damage a single address can do is the reason both scopes exist.
- **An unresolvable scope is not a free pass.** `invitations` and `scanCreate` are keyed only
  per organisation, and there is no tenant context before Phase 2. If the guard simply skipped
  a scope it could not resolve, those fail-closed classes would carry no limit at all. When
  every declared scope is unresolvable the class's `failMode` applies, exactly as it does for a
  Redis outage.

One row above is **not** yet transcribed into configuration: webhook test delivery. Its scope
is a webhook endpoint ID, which is neither an IP, a principal, nor an organisation, and nothing
can resolve one until the webhooks module ships in Phase 9. Keying it against the wrong scope
would be worse than omitting it, because it would look enforced.

One row above was **added by Phase 2 Task 8 rather than quoted from an earlier version of this
document**: email verification submit, 30 / hour per IP, as `emailVerificationConsume`. It is
recorded that way because the figure is a decision and not a quotation. Three notes on it:

- **Per IP only.** The request body is `{ token }` and carries no account, so there is nothing
  for a per-account window to key on. Applying the resend class instead would have declared a
  `perPrincipal` scope sourced from a body field that does not exist — resolving nothing on
  every request while the per-IP half resolved, which is exactly the silent miss the
  per-account note above is about.
- **Defaulting it was not an option.** A route with no class falls to `generalSession`, which is
  fail-open with an unresolvable per-principal scope as its only window, and nothing reports
  that at the default log level. On this route the default would have been no limit and no
  signal, not a weaker limit.
- **The threat is not token guessing.** Verification tokens are 32 random bytes, so brute force
  is infeasible at any rate this table could express. What 30 / hour bounds is unmetered
  database writes from an unauthenticated endpoint: each submission runs a conditional `UPDATE`
  inside a transaction.

**Two more rows were added by Phase 2 Task 10 on the same terms** — password reset submit and
password change. §1 had a row for *requesting* a reset and none for completing one or for
changing a password, so both figures are decisions taken in `rate-limit.config.ts` and written
here in the same change, not quotations.

`Password reset submit` — `passwordResetConsume`, 20 / hour per IP, fail closed — is
`emailVerificationConsume`'s twin and differs from it in one respect that sets the figure. Both
are per IP only, because the body (`{ token, password }`) carries no account and deriving one
from the token would mean a database read bought by an unauthenticated caller *before* the
limiter has decided anything. Both are unrelated to guessing the token, which is 32 random
bytes. What differs is the unit of work bought: this endpoint pays a full **Argon2id hash** of
the submitted password on every request — ADR-0014 targets ~250 ms of it — where verify-email
pays only a transaction. Twenty is the lower figure for that reason, and still generous for an
act a real user performs once.

**And the expensive work is bought BEFORE the token is validated**, which is what makes this
figure the only control standing in front of it. `PasswordResetService` breach-checks and hashes
the submitted password before it consumes the token, deliberately: validating first would let a
caller submitting a garbage token learn — from the response time — that the expensive path was
never entered, and the reset endpoint's whole contract is that its answer does not vary with what
the caller submitted. The consequence for whoever tunes this row is that every request at this
limit costs ~250 ms of Argon2id whether or not the token was ever real.

`Password change` — `passwordChange`, 10 / hour per IP, fail closed — is the one row in this
table that is a **security control rather than bookkeeping**, and the reasoning matters more than
the number:

- The endpoint verifies the caller's **current** password, so it is a credential-guessing oracle
  for anyone holding a stolen session. The account is already fixed by the session cookie, the
  answer is a clean 401/200 split, and none of it touches `User.failedLoginCount` or the lockout
  ladder — those live on the login path, and this endpoint reaches neither.
- Without a class of its own the route would fall to `generalSession`: 1000/min, fail-open, and
  resolving nothing. That is a thousand password guesses a minute against a known account with no
  lock, no notice and no log line.
- **The per-principal half would be the right key and resolves nothing today.** The account being
  guessed at is the session's owner, which is exactly the scope this limit wants — but the limiter
  runs before the authentication guard (`architecture/backend.md` §3), so an `'authenticated'`
  source resolves on no request. It is left **undeclared** rather than declared-and-unresolvable,
  because a declared scope that never resolves beside a per-IP scope that does is the silent miss
  this section already documents twice. It is named here instead, and it is a second reason to
  want the early-per-IP / late-per-principal split this section says is owed.
- Ten per hour is deliberately much tighter than either reset figure. A password change is a rare,
  deliberate act with no legitimate high-volume case behind a shared egress address.

## 2. Quotas and concurrency

Quotas come from entitlements ([`../architecture/billing.md`](../architecture/billing.md)),
checked before enqueue and again in the worker. Concurrency is capped per organisation as
well as globally so no tenant can starve the queue; per-target-host request budgets prevent
the platform being used as a load generator.

## 3. Signals monitored

Scan volume anomalies against the tenant's own baseline; **high scope-denial rates**, which
usually mean someone is probing for what they can reach; new organisations scanning
immediately after signup; the same target appearing across unrelated tenants; targets
matching sensitive ranges; disposable email domains at registration; many organisations from
one IP; payment failures combined with heavy usage; and inbound abuse reports.

Scope-denial rate is the highest-signal metric in the product. A legitimate customer
occasionally mistypes a host. Someone systematically discovering the boundary of what we
will scan looks completely different, and that difference is detectable.

## 4. Enforcement ladder

Observe → warn → throttle → restrict (block new scans, keep read access) → **suspend**
(cancel running scans, block all mutation, retain data, notify owner) → terminate (with
data export offered, unless legally prohibited).

Suspension is reversible and audited. Every step is an audit event; every step above "warn"
notifies the organisation owner with a reason and an appeal path. Automated systems may
throttle and restrict; **only a human suspends or terminates**, because a false positive
here breaks a paying customer's security programme.

## 5. Verification gates

Progressive trust rather than a single gate at signup:

| Capability | Requires |
|---|---|
| Create an organisation | Verified email |
| Register an asset | Verified email |
| Scan a domain asset | Verified email + verified asset ownership |
| Scan an IP or CIDR | The above + **manual operator review** |
| Aggressive profile | The above + `scan.create_aggressive` + explicit per-scan opt-in |
| High concurrency | Paid plan |

## 6. Testing requirements

Limits enforced per IP and per principal; correct headers and `Retry-After`; limits reset;
per-plan overrides apply; concurrency cap holds under parallel load; quota exhaustion
returns 402 with a clear message; suspension blocks new scans and cancels running ones;
suspension is reversible; every enforcement action writes an audit event.

Covered in Phase 1 by `rate-limit.integration.spec.ts` and `sliding-window.integration.spec.ts`,
against a real Redis: the boundary in both directions (exactly `limit` allowed, the next
refused); `limit` admitted out of many *genuinely concurrent* requests, not sequential ones,
since a read-then-write limiter passes the sequential version of that test and fails this one;
two requests in the same millisecond counted as two, which they are not if the sorted-set member
is the timestamp; the window sliding; a reset derived from the oldest entry rather than from
now; scope and class isolation; a forged `X-Forwarded-For` failing to mint a bucket; and both
fail modes with Redis genuinely unreachable. Redis-outage tests point a second application at a
dead port rather than stopping the shared container.

Two further properties are asserted because each held only by accident before it was: that the
liveness probe issues **no Redis command at all** (watched on a live `MONITOR` connection, not
reasoned about — the rate limiter is a backing-service dependency, and `monitoring.md` §5
defines liveness as depending on none), and that a request refused by one scope leaves the
other scope's window unspent.

Guards run after routing, so a request that matches no route is not rate limited — it is
answered by the framework's 404 before any guard sees it. The same is true of a request whose
body fails to parse: the parser answers 400 first. Both are cheap to serve and neither reaches
a handler, but neither is metered either. That is inherent to the mechanism and
differs from the middleware in the same pipeline table, which covers every response.

Not yet covered: per-plan overrides, concurrency, quotas, and everything in §4 — all of which
belong to the phases that build them.
