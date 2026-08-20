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

/**
 * THE TENANT ROOT.
 *
 * `Organization` is the tenant itself — it has no `organizationId` column, so
 * it does not belong in `TENANT_OWNED_MODELS`, but every operation on it must
 * still be scoped, keyed on `id` rather than `organizationId`. Modelled as a
 * distinct concept (not folded into the registry above) so Task 14's
 * DMMF-driven coverage check can require every model to be accounted for by
 * exactly one of "tenant-owned", "tenant root", or "deliberately global" —
 * rather than a model silently falling through all three because the
 * checker only knew about two.
 */
export const TENANT_ROOT_MODEL = 'Organization' as const;

export type TenantRootModel = typeof TENANT_ROOT_MODEL;

export function isTenantRootModel(model: string | undefined): model is TenantRootModel {
  return model === TENANT_ROOT_MODEL;
}
