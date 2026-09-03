/**
 * Injection tokens local to the roles module.
 *
 * Strings rather than symbols, for the reason `infrastructure/tokens.ts` gives:
 * an unresolved dependency names itself in Nest's boot error instead of
 * printing `Symbol(...)`.
 */

/**
 * "Is this user an active member of this organisation, with what role, holding
 * which permissions, and is the organisation itself active?"
 *
 * A port rather than a Prisma client, for the reason every other narrow port in
 * this codebase gives, plus one that is specific to this question: the
 * production implementation must run inside `withTenantTransaction`, and a
 * guard holding the base client is a guard that can read any organisation's
 * memberships. The token is what keeps `roles.module.ts` the only place the
 * client reaches it.
 */
export const TENANT_RESOLVER = 'SENTINEL_TENANT_RESOLVER';

/**
 * "What roles can be assigned in an organisation, and what does each one
 * grant?"
 *
 * A port rather than the Prisma client, for the reason `TENANT_RESOLVER` gives
 * one paragraph up: `roles.module.ts` stays the only place the base client
 * reaches this module, and a controller holding that client is a controller
 * that can read any organisation's rows. The answer here is deliberately-global
 * reference data, so unlike the resolver it does not run inside a tenant
 * transaction — `role-catalog.store.ts` says why that is not a hole.
 */
export const ROLE_CATALOG = 'SENTINEL_ROLE_CATALOG';
