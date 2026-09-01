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

Auth: `LOGIN`, `LOGIN_FAILED`, `ACCOUNT_LOCKED`, `LOGOUT`, `MFA_ENABLED`, `MFA_DISABLED`,
`MFA_CHALLENGE_FAILED`, `PASSWORD_CHANGED`, `PASSWORD_CHANGE_FAILED`,
`PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_COMPLETED`, `SESSION_REVOKED`, `USER_REGISTERED`,
`REGISTRATION_BLOCKED_EXISTING_EMAIL`, `EMAIL_VERIFICATION_RESENT`, `EMAIL_VERIFIED`.

The three registration and verification names were added in Phase 2 Task 8. Until then this list
had no name for an account being created at all — the first event in every account-takeover
investigation — and `CLAUDE.md`'s tenth rule was therefore unsatisfiable for the endpoint that
creates one. All four are written into `PlatformAuditEvent`, because none of them has an
organisation.

`ACCOUNT_LOCKED` was added in Phase 2 Task 9, and it is the only one of that task's four names
this list did not already have. It records the failed attempt that trips the per-account lock —
the moment `User.lockedUntil` moves into the future — and it is written **once per lock**, not
once per failure past the threshold. Attempts arriving while a lock is already live change no
state at all (§7 of [`authentication.md`](authentication.md)), so a row for each of them would be
an append-only table an unauthenticated caller can grow at will.

`LOGIN_FAILED` also covers a **denial on an account that is not `ACTIVE`** — an administratively
locked or disabled account presented with a password that was otherwise correct. That row carries
`userStatus` and `passwordAccepted: true` in its metadata, and it is the most
investigation-relevant denial the login endpoint can produce: somebody is holding a working
credential for an account an operator deliberately switched off. It is deliberately **not**
`ACCOUNT_LOCKED`, which has one meaning here — the failed attempt that tripped the *brute-force*
lock — and reusing it would make an administrative status and a brute-force lock
indistinguishable in the table.

`LOGIN`, `LOGIN_FAILED`, `ACCOUNT_LOCKED` and `LOGOUT` are all `PlatformAuditEvent` rows and none
of them may be an `AuditEvent` ([ADR-0019](../decisions/ADR-0019-platform-audit-event-table.md)):
a login happens before any organisation is chosen, and `AuditEvent`'s row-level security policy
refuses an insert that carries none. `LOGOUT`'s `resourceId` is the **`Session`** that was
revoked, not the user — the user is unchanged by a logout and the session row is what moved;
the other three name the `User`, except an attempt against an address with no account, which
names nothing. On every failure the actor is `SYSTEM` with a null `actorId`, for the reason
`REGISTRATION_BLOCKED_EXISTING_EMAIL` gives below: the row exists because it was probably not
the account owner.

`REGISTRATION_BLOCKED_EXISTING_EMAIL` is the failure half of §3's "failures and denials are
audited". Registration answers identically whether or not the address exists, by design, so
without this row a distributed account-enumeration sweep would leave **no trace at all**: the
wire response is the same for every request in it. The row names the existing account as the
`resourceId` and records no actor, because an unauthenticated caller who typed somebody else's
address is not that person.

`PASSWORD_CHANGE_FAILED` was added in Phase 2 Task 10, and it is the only one of that task's four
names this list did not already have. It records a password change refused because the **current**
password was wrong, which §3's "failures and denials are audited" requires and which nothing
produced before. It is the sharper of the two credential-failure rows: reaching it costs a live
session, so unlike `LOGIN_FAILED` an anonymous caller cannot produce it at will, and somebody
holding a session who cannot produce the password is either the account owner mistyping or a
session thief probing. The row's `actorId` is null and its `actorType` is `SYSTEM`, for the same
reason every other failure row here records no actor — the session holder is not necessarily the
account owner, and that is precisely why the row is worth having. The account is named by
`resourceId`.

`PASSWORD_RESET_REQUESTED` is written for an address with **no account** as well, with a null
`resourceId` and **no address anywhere in the metadata**. `forgot-password` answers
`RESET_REQUESTED` for every input by design (§7 of [`authentication.md`](authentication.md)), so
this row is the only trace a distributed sweep leaves; and the address is omitted for the same
reason `LOGIN_FAILED` omits it — `ip` and `requestId` already carry the signal that matters, and
an append-only table is the worst place to record the email address of somebody who is not a
customer. Its actor is `SYSTEM` with a null `actorId` even when the account exists, because the
endpoint is unauthenticated and the caller may be anybody.

`PASSWORD_RESET_COMPLETED` and `PASSWORD_CHANGED` both name the `User` and both carry
`liveSessionsAtWrite` in their metadata — but **they count slightly different things, and the
field name is the same on purpose**. On the reset row it is every session that existed at the
instant the new credential committed, because a reset revokes all of them. On the change row it
**excludes the caller's own session**, which is not revoked but rotated, so the number is the
sessions that were about to be signed out. An earlier version of this paragraph described both as
the former and was off by one for the change row (L6); the code was right and the document was
wrong. That number rather than one row per revoked session, because an
unauthenticated caller can trigger a reset and a row per session would let them size the table;
and that number rather than the revocation's own count, because the revocation happens after the
transaction the audit row lives in — see §2, and `security/authentication.md` §6 for why the
credential must be written before anything is revoked.

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
