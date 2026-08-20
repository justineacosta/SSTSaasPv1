-- Row-level security: the second, independent isolation layer (ADR-0006).
--
-- The mandatory tenant-scoped Prisma client is layer 1. This is layer 2, and it
-- catches what layer 1 cannot: hand-written SQL, raw analytics queries, future
-- ORM changes, and any bug in the extension itself. Two independent mechanisms
-- must both be wrong for a tenant to see another tenant's rows.

-- FORCE is required: without it the table owner bypasses its own policy, which
-- would make the whole thing decorative in any environment where the app and
-- the owner are the same role.

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Membership"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Invitation"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditEvent"
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

-- The audit log is append-only. Tamper-resistance is enforced at the database
-- privilege level rather than by convention, because a convention does not
-- survive an attacker who already has application-level access.
-- See security/audit.md §2 and development/migrations.md §6.
REVOKE UPDATE, DELETE ON "AuditEvent" FROM sentinel_app;

CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
