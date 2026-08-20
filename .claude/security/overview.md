# Security overview

> **Status: Designed. Not Implemented.** Controls land per phase; the table in §5 tracks
> which are real. Nothing here should be read as a claim that a control currently exists.

## 1. Why this platform is a high-value target

Sentinel stores, for many organisations at once: their asset inventory, their unfixed
vulnerabilities with reproduction steps, their penetration test reports, screenshots and
HTTP captures from inside their applications, integration credentials, and source
repository access. A single compromise of this platform is worth more to an attacker than
compromising any one of our customers directly, because it is a pre-written attack plan
for all of them simultaneously.

We therefore assume we are targeted, and design so that a single failure is not fatal.

## 2. Security principles

1. **Server-side enforcement.** The frontend expresses intent; the API enforces. Any
   control that exists only in the browser does not exist.
2. **Default deny.** Scope, permissions, egress, and object access all start closed.
3. **Defence in depth.** Tenant isolation has three layers (§ tenant-isolation) because
   one will eventually be wrong.
4. **Least privilege.** Workers get a job, not the database. Engine containers get a
   target, not a secret.
5. **Assume breach.** Audit everything, scope credentials tightly, make rotation routine,
   keep blast radius small.
6. **Secure by default, not by configuration.** The safe option is the one you get
   without asking.
7. **Verifiable.** Every claim in this tree has a test. A security control without a test
   is a security intention.

## 3. Data classification

| Class | Examples | Handling |
|---|---|---|
| **Public** | Marketing pages, docs, pricing | No restriction |
| **Internal** | Plan definitions, CWE/OWASP reference data | Authenticated read |
| **Confidential** | Projects, assets, scans, user profiles | Tenant-scoped, permission-gated |
| **Restricted** | Findings, evidence, reports, audit logs, asset inventory | Tenant-scoped, permission-gated, access-audited, encrypted at rest |
| **Secret** | Password hashes, session tokens, API key hashes, MFA seeds, integration tokens, Stripe keys, webhook secrets | Never returned by any API, never logged, encrypted with a managed key, shown once at creation if at all |

An API that returns Restricted data must write an access audit event. An API must never
return Secret data — including to the user who created it, after the single reveal at
creation.

## 4. Control map

Each links to its detailed document.

| Domain | Control | Document |
|---|---|---|
| Identity | Argon2id, opaque sessions, TOTP MFA, recovery codes, verification, reset | [`authentication.md`](authentication.md) |
| Access | RBAC, permission matrix, server-side guards, API key scopes | [`authorization.md`](authorization.md) |
| Multi-tenancy | Mandatory scoping, RLS, isolation test suite | [`tenant-isolation.md`](tenant-isolation.md) |
| **Testing safety** | **Ownership proof, scope rules, deny list, double evaluation, SSRF guard** | [`scope-controls.md`](scope-controls.md) |
| Execution | Container isolation, resource caps, egress policy, no secrets in engines | [`worker-security.md`](worker-security.md) |
| Secrets | Env/KMS sourcing, encryption at rest, rotation | [`secrets.md`](secrets.md) |
| Files | Upload validation, content sniffing, isolated serving, presigned access | [`file-security.md`](file-security.md) |
| Accountability | Append-only audit log, tamper resistance | [`audit.md`](audit.md) |
| Transport | TLS 1.2+, HSTS, secure cookies, CSP, security headers | [`transport-and-headers.md`](transport-and-headers.md) |
| Abuse | Rate limits, quotas, anomaly detection, suspension | [`abuse-prevention.md`](abuse-prevention.md) |
| Response | Detection, triage, containment, disclosure | [`incident-response.md`](incident-response.md) |
| Threats | STRIDE analysis and residual risk | [`threat-model.md`](threat-model.md) |

## 5. Implementation status

Updated as each control ships. **This table is the honest answer to "is it secure yet?"**

| Control | Status | Phase |
|---|---|---|
| Password hashing (Argon2id) | Not Implemented | 2 |
| Session management | Not Implemented | 2 |
| MFA (TOTP + recovery) | Not Implemented | 2 |
| RBAC + permission guards | Not Implemented | 2 |
| Tenant scoping (client extension) | Not Implemented | 1 |
| Tenant isolation (RLS) | Not Implemented | 3 |
| Cross-tenant test suite | Not Implemented | 3 |
| Asset ownership verification | Not Implemented | 3 |
| Scope evaluation engine | Not Implemented | 3 |
| Global deny list | Not Implemented | 3 |
| Worker re-validation | Not Implemented | 4 |
| SSRF-guarded HTTP client | Not Implemented | 4 |
| Container isolation for engines | Not Implemented | 4 |
| Audit log (append-only) | Not Implemented | 3 |
| Evidence access authorization | Not Implemented | 5 |
| Rate limiting | Not Implemented | 1 |
| Security headers + CSP | Not Implemented | 1 |
| Secrets management | Not Implemented | 1 |
| SSO / SCIM | Not Implemented | 11 |

## 6. Non-negotiables

A release is blocked if any of these is untrue:

1. No scan can execute against an unverified or out-of-scope target.
2. No tenant can read, write, or enumerate another tenant's data through any interface —
   REST, SSE, file download, report, search, or webhook.
3. No secret is stored in plaintext or written to a log.
4. Every security-relevant action produces an audit event.
5. Authorization is enforced server-side on every endpoint.
6. Engine containers hold no credentials and cannot reach our infrastructure.
