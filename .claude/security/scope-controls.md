# Scope controls and authorisation to test

> **Status: Designed. Not Implemented.** Built in Phase 3 (assets, ownership, scope) and
> Phase 4 (worker enforcement). **No scanning capability may ship before both are done.**

This is the most important security document in the repository. Everything else protects
our customers' data. This protects everyone *else* — the third parties who would be on
the receiving end if the platform were pointed at them.

## 1. The problem

We are building a system that sends attack traffic at network targets on behalf of paying
strangers. Without controls, that is an attack service with an invoice attached. Three
distinct failure modes:

1. **Malicious use** — a customer registers `bank.example.com`, which they do not own, and
   scans it. We become the attacker of record.
2. **Careless use** — a customer means to scan `staging.acme.com`, fat-fingers a CIDR, and
   sweeps a neighbouring network.
3. **Stale authorisation** — a scan is queued while a target is in scope, and executes
   twenty minutes later after the target was removed, the engagement ended, or the
   organisation was suspended for abuse.

Each needs a different control. Ownership verification handles the first, scope rules the
second, re-validation at execution time the third.

## 2. Control 1 — proof of ownership

**An asset cannot be scanned until the organisation has proven control of it.**
`Asset.ownershipVerifiedAt` is null until then, and null blocks scanning at both
enforcement points.

Accepted methods, by asset type:

| Asset type | Methods |
|---|---|
| `DOMAIN`, `SUBDOMAIN` | DNS `TXT` record `sentinel-verification=<token>`; or `CNAME` to a per-org verification host |
| `URL`, `APPLICATION`, `API` | File at `/.well-known/sentinel-verification.txt` containing the token; or an HTML `<meta>` tag; or a response header |
| `IP`, `CIDR` | **Manual review only.** Signed authorisation document naming the range, plus RIR/WHOIS correlation, reviewed by a human platform operator. Never self-service. |
| `REPOSITORY` | OAuth app installation granting access — possession of the grant is the proof |
| `CLOUD_RESOURCE` | Cloud role assumption / resource tag containing the token |
| `MOBILE_APP` | Store listing ownership, or signed authorisation |

Rules:

- Tokens are per `(organisation, asset)`, random, and never reused.
- Verification is **re-checked periodically** (default 30 days) by the scheduler. Domains
  change hands. A lapsed re-check moves the asset to `VERIFICATION_EXPIRED` and blocks new
  scans while leaving historical findings intact and readable.
- Verifying a domain does **not** implicitly verify arbitrary subdomains; a wildcard
  verification is explicit, recorded, and narrower than the customer usually expects, and
  the UI says so.
- Verification is an audited event with the evidence retained (the DNS answer, the HTTP
  response) so we can show why we believed the customer.

**IP ranges are never self-service.** The asymmetry is deliberate: a wrong domain is
usually a wasted scan, a wrong CIDR is an incident involving someone who never heard of us.

## 3. Control 2 — a global deny list that no customer can override

Independent of any tenant's configuration, and evaluated first:

- RFC1918 and loopback, unless the deployment is explicitly configured for on-premise
  internal scanning (an install-time flag, not a tenant setting).
- Link-local `169.254.0.0/16` and **all cloud metadata endpoints** (`169.254.169.254`,
  `fd00:ec2::254`, `metadata.google.internal`, and equivalents).
- Our own infrastructure: the platform's domains, API, database, queue, storage,
  and worker subnets. The scanner must never be able to scan Sentinel.
- Government, military, healthcare-emergency, and critical-infrastructure TLDs and ranges
  on the operator-maintained blocklist.
- Any target on the platform abuse blocklist, added by operators in response to reports.

The deny list is evaluated in the worker as well as the API, and its evaluation is logged
regardless of outcome.

## 4. Control 3 — tenant scope rules

Per project, versioned, ordered, and **default-deny**.

```
evaluate(target, scopeVersion):
    if globalDenyList.matches(target):        return DENY  ("platform policy")
    if not asset.ownershipVerified:           return DENY  ("unverified asset")
    if any DENY rule matches target:          return DENY  ("scope rule")
    if no ALLOW rule matches target:          return DENY  ("not in scope")
    if target.port not in allowedPorts:       return DENY  ("port restriction")
    if asset.environment not in allowedEnvs:  return DENY  ("environment restriction")
    if profile not in allowedProfiles:        return DENY  ("profile restriction")
    return ALLOW
```

Deny always wins over allow, and the absence of a decision is a denial. Every evaluation
returns a **reason**, which is surfaced verbatim to the user — "not in scope" with no
explanation produces support tickets and, worse, encourages people to widen scope blindly
until it works.

Scopes are versioned. A scan records `scopeVersionId`, so we can always answer "what
authorised this scan?" months later.

## 5. Control 4 — evaluate twice, trust the second

```
POST /scans  ->  evaluate  ->  QUEUED  ->  ...delay...  ->  worker  ->  evaluate again  ->  execute
                    ^                                                        ^
              user feedback                                          the real control
```

The API-side check exists so the user gets an immediate, clear error. **The worker-side
check is the one that actually protects third parties**, because it is the last decision
before traffic leaves. It re-reads everything from the database rather than trusting the
job payload: organisation status, subscription state, asset existence and verification,
current scope version, scan cancellation, and entitlements.

A job that fails re-validation terminates as `FAILED` with a precise reason, writes an
audit event, and — if the failure suggests abuse rather than a race — raises a platform
alert. Detail: [`../architecture/workers.md`](../architecture/workers.md).

## 6. Control 5 — SSRF and redirect handling

Every outbound request made by an engine goes through the shared guarded HTTP client:

- Resolve DNS **first**, then validate every resolved address against the deny list, then
  connect **to the validated address** with the `Host` header preserved. This closes the
  DNS-rebinding window between check and connect.
- Re-validate on **every** redirect hop. Cap redirects (default 5).
- Reject non-HTTP(S) schemes outright.
- No proxy inheritance from the environment; egress policy is explicit.

## 7. Control 6 — safe by default

Scan profiles are `PASSIVE`, `SAFE` (default), `STANDARD`, and `AGGRESSIVE`.

- Nothing destructive runs without an explicit, per-scan, logged opt-in that also requires
  a higher permission (`scan.create_aggressive`) than ordinary scanning.
- Injection testing uses non-destructive proofs — detection over exploitation, `SELECT`-shaped
  time delays rather than writes, marker reflection rather than payload execution.
- Rate limits per target host, respected regardless of the customer's own limits, so that
  we cannot be used as a load generator dressed as a scanner.
- Every engine has a hard wall-clock timeout and a request budget.

## 8. Control 7 — abuse detection and response

The scheduler runs continuous checks: scan volume anomalies, high rates of scope denials
(someone probing for what they can reach), newly registered organisations scanning
immediately, targets that appear across unrelated tenants, and inbound abuse reports.

Platform operators can suspend an organisation, which immediately blocks new scans and
cancels running ones. Suspension is audited and notifies the organisation owner.
An `abuse@` contact and a documented response path are prerequisites for production
launch, not nice-to-haves — see [`incident-response.md`](incident-response.md).

## 9. Testing requirements

These tests are release-blocking. A change that makes them pass by weakening them is a
serious defect.

- Unauthorised-target: unverified asset rejected at API **and** at worker.
- Scope evaluation: table-driven cases over allow/deny/port/environment/profile, including
  overlapping and contradictory rules.
- Global deny list: metadata endpoints, loopback, our own infrastructure — rejected even
  when a tenant explicitly allows them.
- Race: scope narrowed after enqueue, before execution — worker must refuse.
- Suspension: organisation suspended after enqueue — worker must refuse.
- SSRF: DNS-rebinding target, redirect to internal address, redirect chain to metadata —
  all refused, with the refusal logged.
- Verification: token mismatch, expired verification, wildcard not implying subdomains.
