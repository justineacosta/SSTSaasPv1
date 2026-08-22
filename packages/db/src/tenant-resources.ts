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

/**
 * THE DELIBERATELY-GLOBAL REGISTRY — the third and last account.
 *
 * `pnpm check:registry` requires every model in the Prisma datamodel to be
 * accounted for by **exactly one** of `TENANT_OWNED_MODELS`,
 * `TENANT_ROOT_MODEL`, or this map. A model in none of the three has been
 * thought about by nobody, and a check keyed on the `organizationId` column can
 * never flag the one that leaked hardest — `Organization` itself carries no
 * such column.
 *
 * The value is the reason, and the reason is not decoration: the check fails on
 * an empty one. An unexplained entry here is how a tenant-owned table gets
 * parked on this list to make the build go green. Adding a model here is a
 * claim that it holds no customer data belonging to one organisation; if that
 * claim is false, this is where the leak starts.
 *
 * Note that listing a model here does not exempt it from the column rule: a
 * model carrying `organizationId` is reported by `findUnregisteredTenantModels`
 * regardless of what this map says about it.
 *
 * See security/tenant-isolation.md §1 for what the tenant boundary is, and
 * development/migrations.md §5 for the checklist a new tenant table owes.
 */
export const DELIBERATELY_GLOBAL_MODELS = {
  User: 'One human with one login across many organisations; membership is what binds them to a tenant.',
  Credential:
    'The password hash for a User, one-to-one with it — an authentication fact, not a tenant fact.',
  Session:
    'A browser session belongs to a User, not to an organisation; it only names an active organisation.',
  Role: 'System-wide reference data in Phase 1; per-organisation custom roles are Phase 11 and will add a nullable organizationId.',
  Permission:
    'System-wide reference data — the permission catalogue is identical for every tenant.',
  RolePermission: 'The join between two pieces of system-wide reference data.',
} as const;

export type DeliberatelyGlobalModel = keyof typeof DELIBERATELY_GLOBAL_MODELS;

export const DELIBERATELY_GLOBAL_MODEL_NAMES = Object.keys(
  DELIBERATELY_GLOBAL_MODELS,
) as readonly DeliberatelyGlobalModel[];

const DELIBERATELY_GLOBAL_SET: ReadonlySet<string> = new Set(DELIBERATELY_GLOBAL_MODEL_NAMES);

export function isDeliberatelyGlobalModel(
  model: string | undefined,
): model is DeliberatelyGlobalModel {
  return model !== undefined && DELIBERATELY_GLOBAL_SET.has(model);
}
