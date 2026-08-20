# Feature map

Every feature, its phase, and its state. Status here must match
[`roadmap.md`](roadmap.md) — that document is authoritative for phase completion, this one
for feature granularity.

**As of 2026-08-20 every row below is Not Implemented.** The Phase column is the commitment.

## Identity and access — Phase 2

| Feature | Phase |
|---|---|
| Registration, email verification | 2 |
| Login, logout, session management, session list | 2 |
| Password reset, password change | 2 |
| TOTP MFA, recovery codes, org-enforced MFA | 2 |
| Organisation creation, settings, switching | 2 |
| Memberships, system roles, permission guards | 2 |
| Invitations (send, accept, revoke, expire) | 2 |
| Teams | 3 |
| Custom roles | 11 |
| SSO (SAML, OIDC), SCIM | 11 |

## Core domain — Phase 3

| Feature | Phase |
|---|---|
| Projects (CRUD, settings, archive) | 3 |
| Assets (9 types, criticality, environment, owner, tags) | 3 |
| **Asset ownership verification** (DNS, HTTP, meta, manual) | 3 |
| Scope, scope rules, versioning, **evaluation engine** | 3 |
| **Global deny list** | 3 |
| Tags, saved filters | 3 |
| Search across projects, assets, findings, scans | 3 |
| Notifications (in-app, email, preferences) | 3 |
| Audit log (append-only, filterable, exportable) | 3 |

## Execution — Phase 4

| Feature | Phase |
|---|---|
| BullMQ queues, worker orchestration | 4 |
| Container isolation, resource limits | 4 |
| Job lifecycle: retry, timeout, cancellation, dead-letter | 4 |
| **Worker-side re-validation** | 4 |
| SSRF-guarded HTTP client | 4 |
| Scan creation, configuration, monitoring, history | 4 |
| Progress reporting, scan logs | 4 |
| SSE realtime events | 4 |
| Worker health and metrics | 4 |

## Findings — Phase 5

| Feature | Phase |
|---|---|
| Web security engine (headers, TLS, cookies, CORS, disclosure, redirect, fingerprint, and more) | 5 |
| Result normalisation and verification | 5 |
| **Fingerprinting and deduplication with occurrence history** | 5 |
| Finding CRUD, status state machine, activity timeline | 5 |
| Severity, confidence, CVSS, CWE, OWASP mapping | 5 |
| Risk scoring, SLA tracking | 5 |
| Assignment, comments, bulk triage | 5 |
| Evidence capture, upload, storage, redaction, viewer | 5 |
| Dashboard metrics (all live queries) | 5 |
| API security engine (OpenAPI import, discovery, BOLA/IDOR, injection) | 6 |

## Pentest workspace — Phase 7

| Feature | Phase |
|---|---|
| Engagements (scope, timeline, status, members) | 7 |
| Methodology templates, test cases, results | 7 |
| Manual finding entry | 7 |
| Retests (create, execute, `PASSED`/`FAILED`/`INCONCLUSIVE`, finding update) | 7 |
| Collaboration: comments, mentions, assignment | 7 |

## Output and integration — Phases 8–9

| Feature | Phase |
|---|---|
| Reports: technical, executive, retest | 8 |
| PDF and HTML generation, branding, download authorisation | 8 |
| Outbound webhooks: signing, retry, backoff, delivery logs, test | 9 |
| GitHub, GitLab, Bitbucket | 9 |
| Jira, Linear | 9 |
| Slack, Microsoft Teams | 9 |
| API keys: create, scope, rotate, revoke, usage | 3 (model) / 9 (surface) |
| OpenAPI schema and public API docs | 9 |

## Commercial and enterprise — Phases 10–11

| Feature | Phase |
|---|---|
| Stripe checkout, subscription lifecycle, webhooks | 10 |
| Entitlement projection and enforcement | 10 |
| Usage metering, invoices, plan changes | 10 |
| Data retention policies | 11 |
| Platform administration, feature flags | 11 |
| Terraform IaC | 11 |

## Marketing site — Phase 1 onward

Landing, features, solutions, security, pricing, documentation, customers, about, contact,
changelog, status, terms, privacy, security policy. Built incrementally alongside the app;
the pricing page is generated from the same plan seed data as entitlements so the two
cannot disagree.

## Future engines — Phase 12

SAST, dependency scanning, container scanning, cloud security, network security, mobile,
LLM/AI security, performance, load, accessibility, visual regression, compliance,
threat modelling, attack path analysis. All behind the contract in
[`../scanners/engine-contract.md`](../scanners/engine-contract.md) — each is a plugin, not
an architectural change.
