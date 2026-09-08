# Security overview

> **Status: Partially Implemented.** Controls land per phase; the table in §5 tracks which
> are real, and it is the only sentence in this document that should be read as a claim
> about what exists today. Everything else here is design.
>
> **§5 was frozen at Phase 2 Task 3 until Task 18 re-ran it on 2026-09-08.** It had said
> "Not Implemented" for sessions, MFA, RBAC, tenant scoping, rate limiting and security
> headers long after every one of them was built and shipping — in the table that calls
> itself "the honest answer to *is it secure yet?*". No task owned this document, which is
> how it happened; Task 18's doc audit is what found it.

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

**Re-verified 2026-09-08 by Task 18**, by opening the caller rather than by recalling the
plan. Rows still reading Not Implemented for a later phase were not re-checked and are the
phase plan's claim, not a measurement.

| Control | Status | Phase |
|---|---|---|
| Password hashing (Argon2id) | **Implemented** — hashing, verification and transparent rehash-on-raise, called by `registration.service.ts`, `login.service.ts` and `mfa-enrolment.service.ts`. The "no caller exists" this row carried was true at Task 3 and false from Task 8 | 2 |
| Password breach check (HIBP k-anonymity) | **Implemented, and off by default** — `registration.service.ts:90` calls `isBreached`; `PASSWORD_BREACH_CHECK_ENABLED` defaults to `false` so no suite depends on a third party, and the check fails open per [ADR-0015](../decisions/ADR-0015-password-breach-check-fails-open.md). "Called by nothing" was false from Task 8 | 2 |
| Session management | **Implemented** — opaque server-side sessions, rotation, revocation and a Redis read-through cache; `AuthenticationGuard` resolves every authenticated request through it. Revocation is proven immediate by an E2E step, not only by a unit test | 2 |
| MFA (TOTP + recovery) | **Implemented** — enrol, confirm, verify, disable and recovery codes, with a replay defence that records the accepted step. An independent RFC 6238 implementation signs in through the product in `apps/web/e2e/authentication-journey.spec.ts` | 2 |
| RBAC + permission guards | **Implemented** — seven modules declare `@RequirePermission()`, and `authorization-matrix.integration.spec.ts` asserts the denial for every route. CI runs it as its own named step | 2 |
| Tenant scoping (client extension) | **Implemented** — `packages/db/src/tenant-client.ts`, with `pnpm check:registry` gating registry rot in CI. **Row-level security is the separate Phase 3 line below and is still Not Implemented** | 1 |
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
| Rate limiting | **Implemented** — the mechanism in Phase 1, applied in Phase 2: eight route groups declare a class. **With a named residual**: `generalSession`'s only scope resolves nothing before authentication, so `logout`, `session`, `switch-org`, the three session routes and `invitations/accept` ship effectively unlimited (carry-forward rulings 55 and 90) | 1 |
| Security headers + CSP | **Implemented** — enforcing in test, staging and production, report-only in development only. Asserted on a real response by the Playwright suite rather than in a unit test | 1 |
| Secrets management | Partially Implemented — every secret is validated at boot by `packages/config`, nothing is stored in plaintext, and `pnpm check:secrets` fails CI on a credential-shaped literal. **There is no vault and no rotation**: `MFA_SECRET_ENCRYPTION_KEY` is a single process-held key and its incremental rotation is explicitly not built | 1 |
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
