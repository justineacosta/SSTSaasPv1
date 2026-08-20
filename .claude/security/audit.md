# Audit architecture

> **Status: Designed. Not Implemented.** Phase 3.

## 1. Requirements

An audit log that can be edited by the application is not an audit log. Ours must be
append-only, complete for security-relevant actions, tamper-resistant from every normal
application path, queryable by tenants for their own events, and retained per policy.

## 2. Tamper resistance

The application database role holds `INSERT` and `SELECT` on `AuditEvent` and **no
`UPDATE` or `DELETE` grant**. This is enforced by a migration that revokes them, so
tampering requires database-administrator credentials rather than an application bug. A
`BEFORE UPDATE OR DELETE` trigger raises an exception as a second barrier.

Events are written **in the same transaction as the change they describe**. If the change
rolls back, so does the audit event; if the audit write fails, the change fails. An action
that succeeded without a record, or a record of an action that did not happen, are both
worse than an outright error.

Beyond Phase 3, an append-only hash chain (`prevHash`, `hash`) with periodic anchoring
gives detectability of database-level tampering. Recorded here as intended, not built.

## 3. Event shape

```
id, organizationId, actorType, actorId, actorLabel,
action, resourceType, resourceId, resourceLabel,
outcome (SUCCESS | FAILURE | DENIED),
metadata (JSONB, redacted), ip, userAgent, requestId, createdAt
```

`actorType` is `USER`, `API_KEY`, `SYSTEM`, or `PLATFORM_ADMIN`. `actorLabel` and
`resourceLabel` are denormalised snapshots so the log stays readable after the referenced
row is renamed or deleted — an audit log full of dangling IDs is not usable in an
investigation.

**Failures and denials are audited, not only successes.** Failed logins, permission
denials, and scope rejections are the signal an investigation actually needs.

## 4. Actions

Auth: `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `MFA_ENABLED`, `MFA_DISABLED`,
`MFA_CHALLENGE_FAILED`, `PASSWORD_CHANGED`, `PASSWORD_RESET_REQUESTED`,
`PASSWORD_RESET_COMPLETED`, `SESSION_REVOKED`, `EMAIL_VERIFIED`.

Org and access: `ORGANIZATION_CREATED/UPDATED/DELETED/SUSPENDED`, `MEMBER_INVITED`,
`INVITATION_ACCEPTED/REVOKED`, `MEMBER_REMOVED`, `ROLE_CHANGED`, `ROLE_CREATED/UPDATED/DELETED`,
`PERMISSION_DENIED`.

Domain: `PROJECT_*`, `ASSET_CREATED/UPDATED/DELETED`, `ASSET_OWNERSHIP_VERIFIED`,
`ASSET_OWNERSHIP_EXPIRED`, `SCOPE_CHANGED`, `SCAN_CREATED/STARTED/CANCELLED/COMPLETED/FAILED`,
**`SCAN_REJECTED_OUT_OF_SCOPE`**, `FINDING_CREATED/UPDATED/STATUS_CHANGED/ASSIGNED/DELETED`,
`FINDING_RISK_ACCEPTED`, `EVIDENCE_UPLOADED/ACCESSED/DELETED/REDACTED`, `RETEST_*`,
`REPORT_GENERATED/DOWNLOADED`.

Platform: `API_KEY_CREATED/REVOKED/USED_AFTER_REVOCATION`, `WEBHOOK_*`,
`INTEGRATION_CONNECTED/DISCONNECTED`, `SUBSCRIPTION_CHANGED`, `PLATFORM_ADMIN_ACCESS`,
`BREAK_GLASS_ACCESS`.

`SCAN_REJECTED_OUT_OF_SCOPE` and `BREAK_GLASS_ACCESS` are the two most operationally
important events in the system: the first is the abuse signal, the second is the trust
signal.

## 5. Redaction

Metadata passes through the same redacting serialiser as logs. Diffs record which fields
changed and the before/after values **only for non-sensitive fields**; sensitive fields
record the fact of change and nothing more.

## 6. Access

Tenants read their own audit log at `/audit-logs` with `audit.read`, filterable by actor,
action, resource, outcome, and date, cursor-paginated on `(createdAt, id)`, exportable to
CSV/JSON (an export is itself audited). Platform admins have a separate cross-tenant view
which is itself audited. **No API exposes another tenant's events.**

## 7. Retention

Default 1 year; enterprise up to 7 years, per plan entitlement (`auditRetention`). Beyond
the window, events are archived to object storage in an immutable, compressed form rather
than deleted, unless a legal-hold or a data-subject erasure request applies. Retention
enforcement runs in the scheduler.

## 8. Testing requirements

Every mutating endpoint writes an event; a rolled-back transaction writes none; `UPDATE`
and `DELETE` on the table are rejected at the database level; sensitive values are absent
from metadata; a tenant cannot read another tenant's events; failed logins and permission
denials are recorded; export is audited.
