import { isTenantOwnedModel, isTenantRootModel } from './tenant-resources.js';

/**
 * Pure decision logic for how one Prisma operation on one model must be
 * scoped to a tenant. Deliberately has no Prisma dependency and does not
 * touch the network — every branch, including the fail-closed default, is
 * unit-testable without a database. See tenant-scope.spec.ts, in particular
 * for the case a database-backed suite structurally cannot exercise: every
 * real Prisma operation on a tenant-scoped model is now handled explicitly
 * (see the operation sets below), so the terminal `refuse` branch is
 * unreachable through the public Prisma API. Only a direct unit test of
 * `decideScope` with a made-up operation name can prove that branch still
 * fails closed rather than having silently been changed to pass through.
 *
 * `tenant-client.ts` is the thin Prisma-extension adapter around this.
 */

/**
 * Operations whose `where` is a general `WhereInput`: any number of fields,
 * freely combinable with `AND`/`OR`. Scoping here can always safely
 * AND-combine with whatever the caller already filtered by, on any field,
 * including the scope field itself.
 */
const SCOPED_WHERE_MANY_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'deleteMany',
]);

/** Same as above, but the payload also carries a `data` clause to force. */
const SCOPED_WHERE_AND_DATA_MANY_OPERATIONS = new Set(['updateMany', 'updateManyAndReturn']);

/**
 * Operations whose `where` is a `WhereUniqueInput`: Prisma requires at least
 * one genuine unique field directly at the top level (not wrapped in `AND`).
 * `delete` and singular `update` are the two operations here; `findUnique`/
 * `findUniqueOrThrow` are handled separately below (they never touch `where`
 * at all), and `upsert` is handled separately further down (its `where` is
 * also a `WhereUniqueInput`, plus two payloads).
 */
const SCOPED_WHERE_UNIQUE_OPERATION = 'delete';
const SCOPED_WHERE_AND_DATA_UNIQUE_OPERATION = 'update';

/** Operations whose `data` must carry the scope column. */
const SCOPED_DATA_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * The tenant root has no tenant to be created "into" — organisation creation
 * runs through the unscoped client during onboarding, before a TenantContext
 * exists. Refused outright rather than given a (meaningless) scoped
 * interpretation.
 */
const ROOT_DISALLOWED_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

export type ScopePlan =
  | { readonly kind: 'passthrough' }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'run'; readonly args: unknown }
  | {
      readonly kind: 'run-and-check';
      readonly args: unknown;
      readonly checkField: string;
      readonly expected: string;
      readonly notFoundIsThrow: boolean;
    };

function hasOwnScopeContext(organizationId: string | null | undefined): organizationId is string {
  return organizationId !== null && organizationId !== undefined && organizationId !== '';
}

/**
 * Merges a scope predicate into a general `WhereInput`. Safe to AND-combine
 * on any field, including the scope field itself, because `WhereInput` has
 * no "must be a flat unique field" constraint — unlike `WhereUniqueInput`,
 * see `scopeUniqueWhere` below.
 */
export function withScopedWhere(
  where: Record<string, unknown> | undefined,
  keyField: string,
  value: string,
): Record<string, unknown> {
  const base = where ?? {};
  if (Object.hasOwn(base, keyField)) {
    return { AND: [base, { [keyField]: value }] };
  }
  return { ...base, [keyField]: value };
}

/**
 * Scopes a `WhereUniqueInput` for `delete` / singular `update` / `upsert`.
 *
 * These operations require a flat, single-valued unique field at the top
 * level — Prisma rejects `{ AND: [...] }` as a substitute, so the
 * AND-combination `withScopedWhere` uses for general `WhereInput` operations
 * is not a structurally valid option here.
 *
 * When the scope field is absent from the caller's `where` (the common case:
 * a caller targets a tenant-owned row by `id`, not by `organizationId`), it
 * is simply added — identical in effect to `withScopedWhere`.
 *
 * When the scope field IS present and already equals the caller's own
 * tenant, it is left as is.
 *
 * When it is present with a *different* value — a caller explicitly
 * targeting another tenant's `id` (the tenant root) or explicitly filtering
 * by someone else's `organizationId` alongside an `id` — there is no valid
 * `WhereUniqueInput` shape that expresses "this field must equal two
 * different values at once". Silently overwriting the caller's value would
 * redirect the operation onto a different row than the one requested (e.g.
 * "delete org B" silently becoming "delete my own org"), which is worse than
 * refusing outright. So this returns `ok: false`, and the caller (see
 * `decideScope`) turns that into an outright refusal rather than attempting
 * the operation at all.
 */
export function scopeUniqueWhere(
  where: Record<string, unknown> | undefined,
  keyField: string,
  value: string,
): { readonly ok: true; readonly where: Record<string, unknown> } | { readonly ok: false } {
  const base = where ?? {};
  if (Object.hasOwn(base, keyField) && base[keyField] !== value) {
    return { ok: false };
  }
  return { ok: true, where: { ...base, [keyField]: value } };
}

/** Forces the scope column in a write payload, overriding any caller value. */
export function withScopedData(data: unknown, keyField: string, value: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => ({ ...(row as object), [keyField]: value }));
  }
  return { ...(data as object), [keyField]: value };
}

/**
 * Decides how `operation` on `model` must be scoped for `organizationId`.
 *
 * Only ever inspects the top-level operation. It cannot see — and does not
 * attempt to rewrite — models reached through a relation (a nested `include`,
 * or a nested write under `data.someRelation.create/update/...`). Prisma's
 * `$allOperations` hook is invoked once per top-level operation and has no
 * visibility into the nested operations the query planner generates for
 * relations; there is no supported way to intercept those from a client
 * extension. That is precisely the class of case row-level security exists
 * to catch (ADR-0006; security/tenant-isolation.md §2) — see
 * tenant-transaction.integration.spec.ts for the proof that it does.
 */
export function decideScope(
  model: string | undefined,
  operation: string,
  args: unknown,
  organizationId: string | null | undefined,
): ScopePlan {
  const isOwned = isTenantOwnedModel(model);
  const isRoot = isTenantRootModel(model);
  if (!isOwned && !isRoot) return { kind: 'passthrough' };

  if (!hasOwnScopeContext(organizationId)) return { kind: 'refuse' };

  if (isRoot && ROOT_DISALLOWED_OPERATIONS.has(operation)) return { kind: 'refuse' };

  const keyField = isRoot ? 'id' : 'organizationId';

  // findUnique(OrThrow) accepts only unique fields in `where` — a compound
  // unique input (e.g. Membership's `organizationId_userId`) cannot simply
  // have the scope predicate merged in as a sibling key, and rewriting to a
  // different operation (findFirst) would issue that call outside whatever
  // connection or transaction the original call was running on, silently
  // breaking read-your-own-writes and RLS's GUC together. Instead: run the
  // original, unmodified query — which correctly stays on the calling
  // connection/transaction — and check the scope column on the way out.
  if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
    return {
      kind: 'run-and-check',
      args,
      checkField: keyField,
      expected: organizationId,
      notFoundIsThrow: operation === 'findUniqueOrThrow',
    };
  }

  if (SCOPED_WHERE_MANY_OPERATIONS.has(operation)) {
    const typed = args as { where?: Record<string, unknown> };
    return {
      kind: 'run',
      args: { ...typed, where: withScopedWhere(typed.where, keyField, organizationId) },
    };
  }

  if (SCOPED_WHERE_AND_DATA_MANY_OPERATIONS.has(operation)) {
    const typed = args as { where?: Record<string, unknown>; data?: unknown };
    return {
      kind: 'run',
      args: {
        ...typed,
        where: withScopedWhere(typed.where, keyField, organizationId),
        data: withScopedData(typed.data, keyField, organizationId),
      },
    };
  }

  if (operation === SCOPED_WHERE_UNIQUE_OPERATION) {
    const typed = args as { where?: Record<string, unknown> };
    const scoped = scopeUniqueWhere(typed.where, keyField, organizationId);
    if (!scoped.ok) return { kind: 'refuse' };
    return { kind: 'run', args: { ...typed, where: scoped.where } };
  }

  if (operation === SCOPED_WHERE_AND_DATA_UNIQUE_OPERATION) {
    const typed = args as { where?: Record<string, unknown>; data?: unknown };
    const scoped = scopeUniqueWhere(typed.where, keyField, organizationId);
    if (!scoped.ok) return { kind: 'refuse' };
    return {
      kind: 'run',
      args: { ...typed, where: scoped.where, data: withScopedData(typed.data, keyField, organizationId) },
    };
  }

  if (SCOPED_DATA_OPERATIONS.has(operation)) {
    const typed = args as { data?: unknown };
    return { kind: 'run', args: { ...typed, data: withScopedData(typed.data, keyField, organizationId) } };
  }

  if (operation === 'upsert') {
    // `where` is a WhereUniqueInput, same constraint as delete/update above.
    // Both `create` and `update` payloads could otherwise re-parent the row
    // (`create` if no row matches, `update` if one does), so both are forced.
    const typed = args as { where?: Record<string, unknown>; create?: unknown; update?: unknown };
    const scoped = scopeUniqueWhere(typed.where, keyField, organizationId);
    if (!scoped.ok) return { kind: 'refuse' };
    return {
      kind: 'run',
      args: {
        ...typed,
        where: scoped.where,
        create: withScopedData(typed.create, keyField, organizationId),
        update: withScopedData(typed.update, keyField, organizationId),
      },
    };
  }

  // Any operation not enumerated above is refused rather than passed through
  // unscoped. Failing closed is the only safe default here — see
  // tenant-scope.spec.ts for proof this branch is actually reachable and
  // actually refuses.
  return { kind: 'refuse' };
}
