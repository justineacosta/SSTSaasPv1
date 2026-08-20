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
      /**
       * True when `args` was widened (a `select` that didn't ask for
       * `checkField`) or narrowed-back (an `omit` that excluded it) purely so
       * the check below has a value to read. The caller must delete
       * `checkField` from the result before returning it, or a narrow
       * projection the caller legitimately used would come back with an
       * extra field it never asked for.
       */
      readonly stripCheckField: boolean;
    };

function hasOwnScopeContext(organizationId: string | null | undefined): organizationId is string {
  return organizationId !== null && organizationId !== undefined && organizationId !== '';
}

/**
 * `findUnique`/`findUniqueOrThrow`'s "run unmodified, check the result"
 * design (see `decideScope` below) reads `checkField` off whatever the query
 * actually returned — which breaks the moment a caller projects the result
 * with `select`/`omit` and the scope column isn't part of that projection:
 * the field comes back `undefined`, never matches, and an owned row is
 * discarded as if it belonged to another tenant. `select` and `omit` are
 * exactly what CLAUDE.md's N+1 and DTO discipline pushes callers toward, so
 * this had to be handled rather than documented as a limitation.
 *
 * Widens `select` to include `checkField` (if the caller didn't already ask
 * for it) or drops `checkField` from `omit` (if the caller excluded it), so
 * the row always carries what the check needs. `select` and `omit` are
 * mutually exclusive at the same level in Prisma, so at most one branch below
 * ever applies. The caller must then strip `checkField` back out of the
 * result when `stripCheckField` is true, so the shape returned still matches
 * exactly what was asked for.
 *
 * KNOWN GAP, deliberately not fixed (round 3 re-review): a client-level omit
 * — `new PrismaClient({ omit: { membership: { organizationId: true } } })`,
 * as opposed to a per-call `omit` in `args` — reaches this function with
 * `args.omit` still `undefined`, because Prisma applies client-level omit
 * after the extension pipeline, not before. The widening above never fires,
 * so `checkField` comes back `undefined` from every affected `findUnique`,
 * the check in tenant-client.ts's `run-and-check` case never matches, and
 * every owned row is discarded as not found. This fails closed — no leak,
 * just a false negative — and nothing in this codebase constructs a client
 * this way. Not fixed here because a per-call `args.omit` and a client-level
 * one are indistinguishable from inside `$allOperations`; there is no
 * argument available to detect it from. Task 14 is carrying a guard against
 * ever constructing a client with a global `omit` on a scope column.
 */
function adjustProjectionForCheck(
  args: unknown,
  keyField: string,
): { args: unknown; stripCheckField: boolean } {
  const typed = args as { select?: Record<string, unknown>; omit?: Record<string, unknown> };

  if (typed.select !== undefined) {
    if (typed.select[keyField]) return { args, stripCheckField: false };
    return {
      args: { ...typed, select: { ...typed.select, [keyField]: true } },
      stripCheckField: true,
    };
  }

  if (typed.omit !== undefined && typed.omit[keyField]) {
    const nextOmit = { ...typed.omit };
    delete nextOmit[keyField];
    return { args: { ...typed, omit: nextOmit }, stripCheckField: true };
  }

  return { args, stripCheckField: false };
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
    const { args: checkedArgs, stripCheckField } = adjustProjectionForCheck(args, keyField);
    return {
      kind: 'run-and-check',
      args: checkedArgs,
      checkField: keyField,
      expected: organizationId,
      notFoundIsThrow: operation === 'findUniqueOrThrow',
      stripCheckField,
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
