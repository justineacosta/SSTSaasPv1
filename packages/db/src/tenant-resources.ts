/**
 * THE TENANT RESOURCE REGISTRY.
 *
 * Every Prisma model carrying an `organizationId` column must appear here.
 * A CI check reads the Prisma DMMF and fails the build if one does not, which
 * is what stops isolation coverage rotting as the schema grows — isolation bugs
 * do not appear in the code that was reviewed for isolation, they appear in the
 * table someone added six months later.
 *
 * See security/tenant-isolation.md §4 and development/migrations.md §5.
 */
export const TENANT_OWNED_MODELS = ['Membership', 'Invitation', 'AuditEvent'] as const;

export type TenantOwnedModel = (typeof TENANT_OWNED_MODELS)[number];

const TENANT_OWNED_SET: ReadonlySet<string> = new Set(TENANT_OWNED_MODELS);

export function isTenantOwnedModel(model: string | undefined): model is TenantOwnedModel {
  return model !== undefined && TENANT_OWNED_SET.has(model);
}
