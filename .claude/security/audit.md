# Audit architecture

> **Status: Partially Implemented.** The tamper-resistance controls in §2 — `UPDATE`/`DELETE`
> revoked from `sentinel_app`, plus the blocking trigger — landed in Phase 1 (Task 6's row-level
> security migration) for `AuditEvent` and are proven by
> `packages/db/src/rls.integration.spec.ts`. Redaction (§5), the tenant-facing read API (§6), and
> retention (§7) are Designed, Not Implemented; still Phase 3.
>
> **There are two tables as of Phase 2 Task 8, and this document now describes both.**
> `PlatformAuditEvent` holds security-relevant actions that have no organisation — ADR-0019 —
> and carries the same two tamper-resistance controls, reusing the same trigger function. §2 and
> §4 below say which is which.
>
> **Four actions in §4 are written by running code**; every other name in that section is still
> Designed only. `USER_REGISTERED`, `REGISTRATION_BLOCKED_EXISTING_EMAIL`,
> `EMAIL_VERIFICATION_RESENT` and `EMAIL_VERIFIED` are written by
> `apps/api/src/modules/auth/`'s registration and verification endpoints, into
> `PlatformAuditEvent`. Nothing writes an `AuditEvent` row yet, because nothing in the product
> has an organisation to write one for: `Organization` creation is Task 13.

## 1. Requirements

An audit log that can be edited by the application is not an audit log. Ours must be
append-only, complete for security-relevant actions, tamper-resistant from every normal
application path, queryable by tenants for their own events, and retained per policy.

## 2. Tamper resistance

The application database role holds `INSERT` and `SELECT` on **both audit tables** and **no
`UPDATE` or `DELETE` grant** on either. This is enforced by a migration that revokes them, so
tampering requires database-administrator credentials rather than an application bug. A
`BEFORE UPDATE OR DELETE` trigger raises an exception as a second barrier — one trigger
function, `audit_event_is_append_only()`, shared by both tables and naming the table it fired
on.

**The two tables, and which holds what.** ADR-0019.

| Table | Holds | Row-level security |
|---|---|---|
| `AuditEvent` | Every action taken inside an organisation. `organizationId` is NOT NULL. | Yes — `"organizationId" = current_setting('app.organization_id', true)` |
| `PlatformAuditEvent` | Actions that have **no** organisation: an account registering, an address being confirmed. Same columns minus `organizationId`. | No policy, because there is no organisation to filter on. Registered as deliberately global, so `pnpm check:registry` accounts for it. |

The routing rule is **the presence of an organisation, not the kind of action**. `EMAIL_VERIFIED`
for a user who belongs to no organisation is a platform event; the same action for a member
acting inside one is a tenant event. A caller that has an organisation in hand writes
`AuditEvent`; `PlatformAuditService` can only reach the platform table, so it cannot make that
choice wrongly on a caller's behalf.

The cost is stated in ADR-0019 rather than hidden: §6's platform-admin cross-tenant view will
have to read both and merge them, and any future "everything that happened to this user" query
is a union.

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
`PASSWORD_RESET_COMPLETED`, `SESSION_REVOKED`, `USER_REGISTERED`,
`REGISTRATION_BLOCKED_EXISTING_EMAIL`, `EMAIL_VERIFICATION_RESENT`, `EMAIL_VERIFIED`.

The three registration and verification names were added in Phase 2 Task 8. Until then this list
had no name for an account being created at all — the first event in every account-takeover
investigation — and `CLAUDE.md`'s tenth rule was therefore unsatisfiable for the endpoint that
creates one. All four are written into `PlatformAuditEvent`, because none of them has an
organisation.

`REGISTRATION_BLOCKED_EXISTING_EMAIL` is the failure half of §3's "failures and denials are
audited". Registration answers identically whether or not the address exists, by design, so
without this row a distributed account-enumeration sweep would leave **no trace at all**: the
wire response is the same for every request in it. The row names the existing account as the
`resourceId` and records no actor, because an unauthenticated caller who typed somebody else's
address is not that person.

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

Retention covers **both** tables of §2. Default 1 year; enterprise up to 7 years, per plan
entitlement (`auditRetention`). Beyond
the window, events are archived to object storage in an immutable, compressed form rather
than deleted, unless a legal-hold or a data-subject erasure request applies. Retention
enforcement runs in the scheduler.

## 8. Testing requirements

Every mutating endpoint writes an event; a rolled-back transaction writes none; `UPDATE`
and `DELETE` on the table are rejected at the database level; sensitive values are absent
from metadata; a tenant cannot read another tenant's events; failed logins and permission
denials are recorded; export is audited.
