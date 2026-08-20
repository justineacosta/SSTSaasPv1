# Abuse prevention and rate limiting

> **Status: Designed. Not Implemented.** Rate limiting Phase 1; quotas Phase 10; anomaly
> detection Phase 11.

Ordinary SaaS limits abuse to protect its own capacity. We also limit it to protect people
who are not our customers. See [`scope-controls.md`](scope-controls.md) for the controls
that decide *whether* a scan may run; this document covers *how much* and *how fast*.

## 1. Rate limits

Sliding window in Redis, applied per IP **and** per principal — an attacker with many IPs
is caught by the principal limit, and an unauthenticated flood by the IP limit. Limits are
configuration, not constants, and are overridable per plan.

| Endpoint class | Default |
|---|---|
| Login | 5 / 15 min per account, 20 / 15 min per IP |
| Registration | 3 / hour per IP |
| Password reset | 3 / hour per address, 10 / hour per IP |
| Email verification resend | 3 / hour per account |
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
