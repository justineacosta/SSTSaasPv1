# Database architecture

> **Status: Designed. Not Implemented.** The Prisma schema is written in Phase 1
> (identity + core tables) and extended per phase. This document is the design it must
> match; if they diverge, this document is the defect.

PostgreSQL 16 via Prisma. Rationale for both in
[ADR-0002](../decisions/ADR-0002-postgresql-and-prisma.md).

## 1. Conventions

- **Primary keys**: UUIDv7 (`TEXT`, generated in application code). Time-ordered, so
  index locality is good, while remaining non-guessable enough that an enumerated ID is
  useless without authorization — which is itself never the control. See §6.
- **Timestamps**: `createdAt`, `updatedAt` on every table, `timestamptz`, UTC.
- **Soft delete**: only where the domain needs history (`Finding`, `Asset`, `Project`,
  `Membership`). Everything else hard-deletes. Soft-deleted rows are filtered by the
  tenant client, never by hand.
- **Tenant column**: every tenant-owned table carries `organizationId` **directly**,
  even when it is derivable through a join. This is non-negotiable and is what makes
  mandatory tenant scoping possible with a single `where` injection. It denormalises
  one column in exchange for making the entire isolation story mechanical.
- **Money**: integer minor units plus ISO currency code. Never floats.
- **Enums**: Postgres enums for closed domains that change with code (statuses,
  severities); lookup tables for domains that change with data (plans, permissions).

## 2. Entity map

```
Organization
  |- Membership -> User
  |- Team -> TeamMembership
  |- Role (system + custom) -> RolePermission
  |- Invitation
  |- Subscription -> Entitlement (projection of Stripe)
  |- UsageRecord
  |- ApiKey
  |- WebhookEndpoint -> WebhookDelivery
  |- Integration
  |- AuditEvent
  |- Notification
  |- FeatureFlagOverride
  \- Project
       |- Asset
       |     |- AssetOwnershipVerification
       |     \- Tag (via AssetTag)
       |- Scope -> ScopeRule
       |- Scan -> ScanTarget, ScanLog, ScanArtifact
       |- Engagement
       |     |- EngagementScope
       |     |- TestCase -> TestCaseResult
       |     \- EngagementMember
       |- Finding
       |     |- FindingOccurrence
       |     |- Evidence
       |     |- FindingComment
       |     |- FindingActivity
       |     \- Retest -> RetestResult
       \- Report -> ReportArtifact

User (global)
  |- Credential (Argon2id hash)
  |- MfaFactor (TOTP, recovery codes)
  |- Session
  |- EmailVerificationToken / PasswordResetToken
  \- IdentityProviderLink (SSO, Phase 11)
```

`User` is **global**, not tenant-owned — one human, one login, many organisations.
`Membership` is the join that makes them a tenant participant. This is what makes
organisation switching and multi-org consultants work, and it is the reason
authorization is always evaluated as `(user, organization, permission)` and never as
`(user, permission)`.

## 3. The tables that carry the most design weight

### Asset

The unit of "a thing we may test". Type is a closed enum: `DOMAIN`, `SUBDOMAIN`, `URL`,
`API`, `IP`, `CIDR`, `REPOSITORY`, `APPLICATION`, `CLOUD_RESOURCE`, `MOBILE_APP`.

Carries `environment` (`PRODUCTION`/`STAGING`/`DEVELOPMENT`/`TEST`), `criticality`
(`CRITICAL`..`LOW`, feeds risk scoring), `ownerId`, `status`, `description`, tags.

The field that matters most: **`ownershipVerifiedAt` / `ownershipVerificationMethod`**.
Null means the asset has never been proven to belong to this organisation, and **no scan
may target it**. Enforced by a check in the scan service and again in the worker. See
[`../security/scope-controls.md`](../security/scope-controls.md).

Constraints: `UNIQUE (organizationId, projectId, type, normalizedValue)` where
`normalizedValue` is the canonicalised host/URL/CIDR — this is what stops the same asset
being registered twice with cosmetic differences.

### Scope and ScopeRule

`Scope` belongs to a project. `ScopeRule` rows are ordered, typed
(`DOMAIN`/`SUBDOMAIN_WILDCARD`/`URL_PREFIX`/`IP`/`CIDR`/`PORT_RANGE`), and each is
`ALLOW` or `DENY`. Evaluation is **deny-wins, default-deny**: a target must match at
least one ALLOW and no DENY. Also carries port restrictions, permitted environments, and
permitted scan profiles.

Rules are immutable once a scan references them: editing a scope creates a new
`ScopeVersion` rather than mutating rules in place, so a completed scan can always be
shown against the scope that authorised it. This matters for audit and for disputes.

### Scan

Status: `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`.
Holds `engineId`, `engineVersion`, `config` (JSONB, validated against the engine schema),
`scopeVersionId`, `progress`, `startedAt`, `finishedAt`, `failureReason`, and counters.
`ScanLog` is append-only worker output. `ScanTarget` records the concrete resolved
targets, which is the record of what was actually contacted.

### Finding and FindingOccurrence

The dedup model, which is the single most consequential schema decision in the product.
A `Finding` is the *vulnerability*, stable across time. A `FindingOccurrence` is *one
sighting* of it by one scan or one manual test.

```
Finding (fingerprint unique per organisation+asset)
  |- Occurrence  scan #1, 2026-08-01, evidence A
  |- Occurrence  scan #2, 2026-08-08, evidence B
  \- Occurrence  scan #3, 2026-08-15, evidence C
```

`fingerprint` is a deterministic hash — see
[`../scanners/finding-deduplication.md`](../scanners/finding-deduplication.md) — with
`UNIQUE (organizationId, assetId, fingerprint)`. A rescan that sees the same
vulnerability inserts an occurrence and touches `lastSeenAt`; it does **not** create a
second finding and does **not** silently reopen a triaged one. A finding not seen by a
scan that would have detected it gets `lastSeenAt` left stale, which is what drives
auto-resolution and the "fixed?" prompt.

Status enum: `OPEN`, `CONFIRMED`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, `REMEDIATED`,
`RETESTING`, `RESOLVED`, `REOPENED`. Transitions are validated in a state machine in the
domain layer, not by free assignment, and every transition writes a `FindingActivity` row
plus an audit event.

Also carries: `severity`, `confidence`, `cvssVector`/`cvssScore`, `cweId`, `owaspCategory`,
`riskScore`, `slaDueAt`, `assigneeId`, `remediation`, `references`.

### Evidence

Metadata in Postgres, bytes in object storage. Columns: `type` (`SCREENSHOT`,
`HTTP_REQUEST`, `HTTP_RESPONSE`, `LOG`, `JSON`, `TEXT`, `FILE`, `ARTIFACT`),
`storageKey`, `sizeBytes`, `contentType`, `sha256`, `uploadedById`, `redactedAt`.
Storage keys are always prefixed `org/{organizationId}/...` so that a key leak cannot
address another tenant's object, and access is authorised on **every** read including
presigned-URL issuance. See [`storage.md`](storage.md).

### AuditEvent

Append-only. `actorType` (`USER`/`API_KEY`/`SYSTEM`/`PLATFORM_ADMIN`), `actorId`,
`action`, `resourceType`, `resourceId`, `metadata` (JSONB, redacted), `ip`, `userAgent`,
`requestId`, `createdAt`. No `UPDATE` or `DELETE` grant exists for the application role —
tamper-resistance is enforced at the database privilege level, not by convention. See
[`../security/audit.md`](../security/audit.md).

### Subscription and Entitlement

`Subscription` mirrors Stripe (`stripeCustomerId`, `stripeSubscriptionId`, `status`,
`currentPeriodEnd`). `Entitlement` is a flat, queryable projection: one row per
`(organizationId, key)` with a numeric or boolean value. The application asks
"what is `maxConcurrentScans` for this org?" and never "is this org on Pro?". See
[ADR-0008](../decisions/ADR-0008-billing-architecture.md).

## 4. Indexing strategy

Indexes are designed against the actual access patterns, not added reactively.

| Pattern | Index |
|---|---|
| Every tenant-scoped list | leading `organizationId` on **every** tenant table |
| Findings list, the hottest query | `(organizationId, status, severity, lastSeenAt DESC)` |
| Findings by project/asset | `(organizationId, projectId, status)`, `(organizationId, assetId, status)` |
| Dedup lookup | `UNIQUE (organizationId, assetId, fingerprint)` |
| Occurrence history | `(findingId, seenAt DESC)` |
| Scan queue + monitoring | `(organizationId, status, createdAt DESC)` |
| Audit log | `(organizationId, createdAt DESC)`, `(organizationId, actorId, createdAt DESC)` |
| Cursor pagination | every paginated list sorts on an indexed `(sortKey, id)` pair |
| Search | GIN on `tsvector` columns for findings, assets, projects |
| SLA sweep | partial index `WHERE status IN ('OPEN','CONFIRMED') AND slaDueAt IS NOT NULL` |

Partial indexes are used aggressively for the status-filtered queries, because open
findings are a small fraction of total findings in a mature tenant and that is the
fraction the product looks at constantly.

## 5. Integrity rules that live in the database

Application code is the second line of defence, never the first.

- Foreign keys on every relation, with deliberate `ON DELETE` behaviour: `CASCADE` for
  owned children (occurrences, evidence metadata, scope rules), `RESTRICT` where deletion
  should be refused (a project with findings), `SET NULL` for optional references
  (assignee).
- `UNIQUE` on: `(organizationId, slug)`, `(organizationId, userId)` for membership,
  `(organizationId, assetId, fingerprint)`, API key hash, session token hash.
- `CHECK` constraints on: severity/CVSS range agreement, `finishedAt >= startedAt`,
  non-negative counters, `ownershipVerifiedAt IS NULL OR ownershipVerificationMethod IS NOT NULL`.
- Optimistic concurrency via a `version` integer on `Finding` and `Scope`, so two
  triagers cannot silently overwrite each other.

## 6. Tenant isolation at the data layer

Two layers, both required.

1. **A mandatory tenant-scoped Prisma client.** Request context carries
   `organizationId`; a Prisma client extension injects it into `where` for every read
   and into `data` for every write on tenant-owned models, and throws if it is absent.
   Handlers receive only this client. The unscoped client is exported from a single
   module that lint rules forbid importing outside migrations, seeds, and the platform
   admin module.
2. **PostgreSQL Row-Level Security** as defence in depth, enabled per tenant table with
   a policy on `current_setting('app.organization_id')`, set per transaction. This
   catches the case the extension misses — including hand-written SQL.

**Neither layer is trusted alone, and neither is trusted at all without tests.** Every
tenant-owned resource gets an integration test asserting Tenant A receives 404 for
Tenant B's IDs across read, update, delete, list, export, evidence download, and
websocket/SSE subscription. Detail:
[`../security/tenant-isolation.md`](../security/tenant-isolation.md).

## 7. Migrations, backup, recovery

Prisma Migrate, forward-only, reviewed. Expand/contract for anything destructive:
add nullable, backfill, switch reads, then drop in a later release — never in one step.
Migrations run as a separate CI/CD stage, not on application boot, so that N application
instances cannot race. Full policy: [`../development/migrations.md`](../development/migrations.md).

Backup and restore, including the tested restore drill: [`../operations/backups.md`](../operations/backups.md)
and [`../operations/disaster-recovery.md`](../operations/disaster-recovery.md).

## 8. Seeds

The seed script loads **reference data only**: CWE catalogue, OWASP categories, system
roles and their permissions, plan definitions and default entitlements, engine registry
rows. It never creates fake organisations, users, findings, or scans — an empty product
must look empty. Demo fixtures for E2E tests live with the tests and are created through
the real API, so that the tests exercise real code paths.
