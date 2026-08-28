-- Actions with no organisation get their own audit table (ADR-0019).
--
-- `CLAUDE.md`'s tenth critical rule says every security-relevant action writes an
-- audit event in the same transaction as the change. Registration and email
-- verification are the first two such actions that have NO organisation: both
-- happen before the account belongs to anything.
--
-- `AuditEvent` cannot hold them, and the column type is only the first of four
-- obstructions:
--
--   1. `AuditEvent."organizationId"` is NOT NULL with a `Restrict` foreign key to
--      `Organization`. There is no id to put there that is not a fabrication.
--   2. The table carries row-level security —
--      `USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`,
--      from `20260820121229_row_level_security`. Measured on 2026-08-28 against a
--      scratch table carrying that exact policy, as `sentinel_app`: the
--      tenant-scoped insert succeeded and the NULL-organisation insert was refused
--      with `new row violates row-level security policy`. Relaxing the column to
--      nullable therefore does not make the write work; the policy rewrite is the
--      real decision, and ADR-0019 declines it.
--   3. `security/audit.md` §6 promises that no API exposes another tenant's
--      events. Rows belonging to nobody, sitting in the table every tenant reads,
--      would be a question every future query has to keep answering correctly.
--   4. `pnpm check:registry` requires each model to be accounted for by exactly
--      one of tenant-owned / tenant-root / deliberately-global. A table that is
--      tenant-owned for most rows and global for some has no honest entry.
--
-- So: a second table with the same fields minus `organizationId`, registered as
-- deliberately global, and carrying the same tamper resistance. `AuditEvent` is
-- untouched — its column stays NOT NULL, its policy stays as written, and every
-- query already pointed at it keeps its current meaning.
--
-- This migration is sound on its own: it creates one table, its indexes, its
-- grants and its triggers, and changes nothing that already exists apart from
-- widening the append-only trigger function's message (see below).

-- CreateTable
CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_createdAt_idx" ON "PlatformAuditEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_actorId_createdAt_idx" ON "PlatformAuditEvent"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_resourceType_resourceId_idx" ON "PlatformAuditEvent"("resourceType", "resourceId");

-- ---------------------------------------------------------------------------
-- Tamper resistance, identical to `AuditEvent`'s (security/audit.md §2).
--
-- `infra/docker/postgres/init/01-app-role.sql` sets ALTER DEFAULT PRIVILEGES
-- granting SELECT, INSERT, UPDATE, DELETE on every future table to
-- `sentinel_app`, so the new table arrives with UPDATE and DELETE already
-- granted. The revoke below is therefore not belt-and-braces: without it this
-- table is writable in place by the application role.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "PlatformAuditEvent" FROM sentinel_app;

-- The function `audit_event_is_append_only()` already exists, from
-- `20260820121229_row_level_security`. It is REUSED rather than duplicated
-- (ADR-0019), and replaced here only so its message names the table the trigger
-- actually fired on. The previous text hard-coded `AuditEvent`, which would have
-- reported the wrong table for every refusal on `PlatformAuditEvent` — an
-- operator reading that during an incident would look at the wrong log. Both of
-- `AuditEvent`'s existing triggers keep pointing at this same function and their
-- behaviour is unchanged apart from the table name in the message.
CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_audit_event_no_update
  BEFORE UPDATE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER platform_audit_event_no_delete
  BEFORE DELETE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

-- No row-level security policy, and no `ENABLE ROW LEVEL SECURITY`, deliberately.
-- RLS on this table would have nothing to filter on: the rows carry no
-- organisation, which is the whole reason the table exists. It is registered as
-- deliberately global in `packages/db/src/tenant-resources.ts`, which is the
-- account `pnpm check:registry` requires. A tenant cannot read a platform event
-- because no tenant-facing query points at this table, and Phase 3's `/audit-logs`
-- will have to union the two deliberately — ADR-0019 names that as the cost.
