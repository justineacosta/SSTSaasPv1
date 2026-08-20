# Platform administration

> **Status: Designed. Not Implemented.** Phase 11.
> Access model: [`../security/authorization.md`](../security/authorization.md) §8.

Internal operations for running the SaaS. Deliberately separate from tenant administration:
an organisation `OWNER` runs their organisation; a platform admin runs the platform. Neither
is a superset of the other, and conflating them is how tenant admins end up with accidental
cross-tenant reach.

## 1. Separation

| | Tenant admin | Platform admin |
|---|---|---|
| Identity | Ordinary `User` + `Membership` | `PlatformAdmin`, separate table |
| Auth | Standard login | Separate path, **mandatory hardware-backed MFA**, IP allowlist |
| Surface | `app.sentinel.example` | `admin.sentinel.example`, separate deployment |
| Scope | One organisation | Cross-tenant metadata |
| Audit | Tenant audit log | Separate platform audit stream, `actorType=PLATFORM_ADMIN` |

Platform admin is **not a flag on a user row**. A compromised customer account must not be
able to become a platform admin through privilege escalation, and a shared identity makes
that a one-bug problem.

## 2. Capabilities

Organisations: list, search, view metadata, usage, subscription; suspend and reinstate;
adjust entitlement overrides for negotiated deals; review verification requests for `IP` and
`CIDR` assets — the manual gate from
[`../security/scope-controls.md`](../security/scope-controls.md).

Users: search, view organisation memberships, force password reset, revoke sessions, unlock,
assist with MFA recovery under an identity-verification procedure.

Abuse: review scope-denial anomalies, scan volume outliers, and abuse reports; act on the
enforcement ladder in [`../security/abuse-prevention.md`](../security/abuse-prevention.md).

System: worker fleet health, queue depth and dead letters, database and Redis health,
migration state, feature flags, error rates.

Billing: view subscriptions, reconcile against Stripe, issue credits, resolve failed payments.

## 3. What platform admins cannot do

They **cannot browse tenant findings, evidence, reports, or scan results**. Metadata — counts,
statuses, timestamps — yes. Content, no.

Access to content requires **break-glass**: a written reason, a defined duration, a
`BREAK_GLASS_ACCESS` audit event, and **automatic notification to the organisation owner**
that a named platform operator accessed their data, when, and why. Access expires
automatically. There is no silent path to customer data, and the notification is not
suppressible by the operator using it.

This is a deliberate trade against operational convenience. Debugging a customer issue is
harder this way. Being a security vendor whose staff can silently read every customer's
unfixed vulnerabilities is worse.

## 4. Feature flags

Flags are evaluated server-side and delivered to the client as resolved booleans, never as
rules the client evaluates.

Types: **release** (gradual rollout by percentage), **entitlement** (plan-gated, sourced from
entitlements not hard-coded), **operational** (kill switches for expensive or risky
subsystems), **internal** (staff only).

Every flag has an owner and a removal date. Flags that outlive their rollout become permanent
untested branches, so a stale-flag report runs monthly and flags past their date are treated
as debt with a ticket attached.

Kill switches exist for: each engine class, report generation, webhook delivery, each
integration, registration, and scanning globally. The last one is the emergency stop for the
entire scanning capability, and it is tested rather than assumed.

## 5. Auditing the auditors

Every platform admin action writes to the platform audit stream, which is shipped off-platform
to write-once storage. Platform admins cannot read or modify their own audit stream through
the admin surface. Break-glass events additionally alert the security channel in real time,
so the review is immediate rather than retrospective.
