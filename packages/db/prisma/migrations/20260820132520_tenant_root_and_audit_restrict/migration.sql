-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_organizationId_fkey";

-- AddForeignKey
--
-- CASCADE would let a foreign-key cascade silently destroy the audit trail
-- the moment an organisation is deleted, outside both RLS and the
-- append-only trigger (RI cascades run at a lower level than either).
-- RESTRICT forces an explicit, auditable purge path instead. See
-- security/audit.md and schema.prisma's AuditEvent docstring.
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The tenant root: `Organization` has no `organizationId` column — it *is*
-- the tenant — so its row-level security policy is keyed on `id` instead.
-- Without this, the mandatory scoped client's own `id`-scoping on
-- Organization (tenant-scope.ts) had no independent backstop: hand-written
-- SQL, or a bug in that scoping, could read, rename, or (before the REVOKE
-- below) delete any other tenant's Organization row directly.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Organization"
  USING ("id" = current_setting('app.organization_id', true))
  WITH CHECK ("id" = current_setting('app.organization_id', true));

-- Deleting a tenant is a platform-admin operation (Phase 11), not something
-- request-path code should be able to do at all. Without DELETE, the
-- Organization -> AuditEvent cascade this migration just changed to RESTRICT
-- can never be triggered by the application role in the first place — this
-- is the clean fix for that cascade, not a workaround of it.
REVOKE DELETE ON "Organization" FROM sentinel_app;
