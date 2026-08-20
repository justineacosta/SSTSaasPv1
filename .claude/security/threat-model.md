# Threat model

> **Status: Designed (living document).** Reviewed at each phase boundary and whenever a
> new trust boundary appears.

## 1. Scope and assets

Assets worth attacking, ranked by consequence:

1. **Aggregated vulnerability data** — every customer's unfixed vulnerabilities with
   reproduction steps. The highest-value asset in the system.
2. **Evidence** — screenshots and HTTP captures from inside customer applications,
   frequently containing session tokens, PII, and internal hostnames.
3. **The scanning capability itself** — an authenticated attack platform with egress.
4. **Integration credentials** — repository access, cloud roles, Jira, Slack tokens.
5. **Identity data** — credentials, sessions, MFA seeds.
6. **Billing data** — held by Stripe, not us, which is deliberate.

## 2. Trust boundaries

```
Internet ──▶ Cloudflare ──▶ web ──▶ api ──▶ database
                                     │
                                     ├──▶ redis/queue
                                     │        │
                                     │        ▼
                                     │     workers ──▶ engine container ──▶ TARGET
                                     ▼                     (untrusted both ways)
                                 stripe / smtp / storage
```

The boundary that distinguishes this product from ordinary SaaS is the last one. The
engine container is untrusted **in both directions**: we do not trust what the target
sends back, and we do not trust the engine not to be compromised by it.

## 3. STRIDE

### Spoofing

| Threat | Control |
|---|---|
| Credential stuffing | Argon2id, breach check, rate limits, MFA, anomaly alerts |
| Session theft | `HttpOnly`/`Secure`/`SameSite`, short TTL, rotation, revocation, session list UI |
| API key theft | Hashed at rest, scoped, expiring, IP allowlist, `lastUsedAt`, immediate revocation |
| Stripe webhook forgery | Signature verification with the endpoint secret; replay window enforced |
| Inbound webhook/integration spoofing | Signature verification per provider |

### Tampering

| Threat | Control |
|---|---|
| Modifying findings to hide risk | Full activity trail per finding; audit log; state machine |
| Audit log tampering | Append-only; no `UPDATE`/`DELETE` grant for the app role |
| Report tampering after generation | Content hash stored; reports immutable once generated |
| Queue payload tampering | Workers re-read authoritative state from the database |
| Scope widened to legitimise a past scan | Scope versioned; scans reference the version that authorised them |

### Repudiation

Every security-relevant action writes an audit event with actor, IP, user agent, and
request ID, in the same transaction as the change. Evidence access is itself audited.

### Information disclosure

| Threat | Control |
|---|---|
| **Cross-tenant data access** | Three-layer isolation + generated test matrix |
| Evidence key guessing | Per-org prefixes, no public buckets, authorised presign, short TTL |
| ID enumeration | UUIDv7 + 404-not-403 for cross-tenant |
| Verbose errors | Shared error envelope; internals only in server logs |
| Secrets in logs | Redacting logger with an allowlist-based serialiser |
| Secrets in the browser | No tokens in `localStorage`; session is an `HttpOnly` cookie |
| Findings leaking via search or aggregates | Tenant predicate inside the query, never post-filtered |

### Denial of service

| Threat | Control |
|---|---|
| Application flood | Cloudflare, per-IP and per-principal rate limits |
| Queue exhaustion by one tenant | Per-org concurrency caps and fair scheduling; a tenant cannot starve others |
| Expensive report generation | Queued, quota'd, timeout-capped |
| Storage exhaustion | Per-plan storage entitlement, enforced at upload |
| Zip bombs / huge scan output | Size caps on engine output and uploads, enforced streaming |

### Elevation of privilege

| Threat | Control |
|---|---|
| Custom role granting more than the creator holds | Permission subset enforced at creation |
| API key exceeding its owner | Scope intersection; forbidden permission list for keys |
| Last owner demoted, org orphaned | Constraint: at least one owner |
| **Engine container escape** | Non-root, read-only rootfs, dropped capabilities, seccomp, no host mounts, no secrets, resource caps |
| Worker compromise reaching the database | Workers hold narrow credentials; engines hold none |
| Platform admin abusing access | Separate auth, hardware MFA, break-glass with reason, owner notification |

## 4. Threats specific to a security-testing platform

These have no analogue in ordinary SaaS and get their own attention.

| Threat | Consequence | Control |
|---|---|---|
| **Scanning a third party's assets** | We become the attacker; legal exposure | Ownership verification; IP ranges never self-service ([`scope-controls.md`](scope-controls.md)) |
| **Using the platform as a DDoS relay** | Amplification with our IPs | Per-target rate limits, request budgets, concurrency caps, safe-by-default profiles |
| **SSRF into our own infrastructure** | Full compromise from a scan target field | Guarded HTTP client, DNS-then-connect, redirect re-validation, self-infrastructure deny list |
| **Hostile scan target attacking the engine** | Malicious response exploits a parser | Ephemeral, unprivileged, capped containers; no secrets; egress policy; destroyed after every job |
| **Malicious findings content stored and rendered** | Stored XSS in our UI from attacker-controlled response bodies | Evidence treated as untrusted data: never rendered as HTML, sandboxed viewer, strict CSP |
| **Scope race after enqueue** | Traffic sent to a target no longer authorised | Worker re-validation immediately before execution |
| **Exfiltration via a customer's own webhook** | Attacker with low privileges routes findings out | Webhook creation requires elevated permission; endpoints audited; SSRF rules apply to delivery targets too |

The stored-XSS case deserves emphasis. Scan output is attacker-controlled by definition —
a target can return `<script>` in a header and we will store it as evidence. Evidence is
therefore **never** rendered as markup anywhere in the product, only as escaped text or
inside a sandboxed frame with a restrictive CSP.

## 5. Residual risks accepted

- Shared database across tenants (see [`tenant-isolation.md`](tenant-isolation.md) §5).
- Platform admin break-glass is mitigated, not eliminated.
- Supply chain: we depend on the npm and PyPI ecosystems. Mitigated by lockfiles, pinned
  digests for base images, `pnpm audit`/`pip-audit` in CI, and Dependabot — not solved.
- A determined insider with production database access can read tenant data. Mitigated by
  access controls, audit, and least privilege.

## 6. Review triggers

Re-run this model when: a new engine class is added, a new integration gains write access
to customer systems, the tenancy model changes, SSO/SCIM lands, on-premise deployment is
offered, or any incident occurs.
