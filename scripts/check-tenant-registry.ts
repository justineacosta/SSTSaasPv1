/**
 * `pnpm check:registry` — the tenant resource registry cannot go stale.
 *
 * Runs in the cheap CI lane: no Postgres, no Redis, no MinIO. Everything it
 * reads comes from the generated Prisma DMMF (`Prisma.dmmf.datamodel`, surfaced
 * by `@sentinel/db`'s `datamodelModels()`), which is re-derived from
 * `schema.prisma` on every `prisma generate`. That is the point — the guarantee
 * is re-derived from the artefact that defines it, not from a list a human last
 * looked at.
 *
 * Four rules, all of them failure directions this repository has actually been
 * bitten by or structurally cannot see without them:
 *
 * 1. Every model carrying `organizationId` is in `TENANT_OWNED_MODELS`.
 *    An unregistered tenant table is not covered by the cross-tenant isolation
 *    harness (security/tenant-isolation.md §4).
 * 2. Every entry in `TENANT_OWNED_MODELS` still names a model that still
 *    carries `organizationId`. A registry that lists a model which lost the
 *    column gives false confidence that something is covered when it no longer
 *    needs to be, and hides that a table stopped being tenant-owned.
 * 3. Every model is accounted for by exactly one of tenant-owned / tenant root
 *    / deliberately global. Rules 1 and 2 are keyed on a column, so they are
 *    structurally blind to `Organization`, which has no `organizationId`
 *    because it *is* the tenant (security/tenant-isolation.md §1).
 * 4. No foreign key into a tenant-owned table, **from a parent that is not
 *    itself tenant-scoped**, is `ON DELETE CASCADE`. The qualifier is the rule:
 *    `Membership.organizationId` and `Invitation.organizationId` are `Cascade`
 *    and correct, because the parent there is the tenant root deleting its own
 *    rows. `Membership.userId` was `Cascade` and was a live defect — deleting a
 *    `User` destroyed every other tenant's `Membership` rows for them, below
 *    both RLS and the tenant-scoped client, because referential-integrity
 *    cascades run inside Postgres's constraint machinery beneath both
 *    (security/tenant-isolation.md §2, Layer 2).
 *
 * The pure functions below are unit-tested in `check-tenant-registry.spec.ts`.
 * `main()` is the thin shell that feeds them the real datamodel.
 */
import { fileURLToPath } from 'node:url';

/** The column that makes a row tenant-owned. */
const TENANT_COLUMN = 'organizationId';

/** One foreign key, as seen from the child model whose column holds it. */
export interface RelationInfo {
  readonly field: string;
  readonly parentModel: string;
  /** `undefined` when `schema.prisma` omits `onDelete` — see `findUnsafeCascades`. */
  readonly onDelete: string | undefined;
}

/**
 * A model, reduced to what these rules need.
 *
 * `relations` is optional so a fixture that only exercises the column rules can
 * be written as `{ name, fields }` without inventing an empty array.
 */
export interface ModelInfo {
  readonly name: string;
  readonly fields: readonly string[];
  readonly relations?: readonly RelationInfo[];
}

/** The three accounts a model can belong to. Exactly one, never zero, never two. */
export interface Registries {
  readonly tenantOwned: readonly string[];
  readonly tenantRoot: string;
  readonly deliberatelyGlobal: readonly string[];
}

/** A relation that violates rule 4, and which way it violates it. */
export interface CascadeViolation {
  readonly model: string;
  readonly field: string;
  readonly parentModel: string;
  /** `cascade` — declared `Cascade`. `undeclared` — no `onDelete` at all. */
  readonly kind: 'cascade' | 'undeclared';
}

const carriesTenantColumn = (model: ModelInfo): boolean => model.fields.includes(TENANT_COLUMN);

/** Rule 1 — models carrying `organizationId` that nobody registered. */
export function findUnregisteredTenantModels(
  models: readonly ModelInfo[],
  registry: readonly string[],
): string[] {
  const registered = new Set(registry);
  return models
    .filter((model) => carriesTenantColumn(model) && !registered.has(model.name))
    .map((model) => model.name);
}

/** Rule 2 — registry entries that no longer describe a tenant-owned model. */
export function findStaleRegistryEntries(
  models: readonly ModelInfo[],
  registry: readonly string[],
): string[] {
  const byName = new Map(models.map((model) => [model.name, model]));
  return registry.filter((name) => {
    const model = byName.get(name);
    return model === undefined || !carriesTenantColumn(model);
  });
}

const accountsFor = (name: string, registries: Registries): number =>
  (registries.tenantOwned.includes(name) ? 1 : 0) +
  (registries.tenantRoot === name ? 1 : 0) +
  (registries.deliberatelyGlobal.includes(name) ? 1 : 0);

/** Rule 3, first direction — a model no registry claims. */
export function findUnaccountedModels(
  models: readonly ModelInfo[],
  registries: Registries,
): string[] {
  return models.filter((model) => accountsFor(model.name, registries) === 0).map((m) => m.name);
}

/** Rule 3, second direction — a model claimed by two registries at once. */
export function findMultiplyAccountedModels(
  models: readonly ModelInfo[],
  registries: Registries,
): string[] {
  return models.filter((model) => accountsFor(model.name, registries) > 1).map((m) => m.name);
}

/**
 * Rule 3, third direction — a registered name that matches no model at all.
 *
 * `findStaleRegistryEntries` covers this for `TENANT_OWNED_MODELS` only. Without
 * this, a deliberately-global entry could outlive the model it names and no
 * rule would notice.
 */
export function findUnknownRegistryEntries(
  models: readonly ModelInfo[],
  registries: Registries,
): string[] {
  const known = new Set(models.map((model) => model.name));
  return [
    ...registries.tenantOwned,
    registries.tenantRoot,
    ...registries.deliberatelyGlobal,
  ].filter((name) => !known.has(name));
}

/**
 * Rule 3, fourth direction — a deliberately-global entry with no stated reason.
 *
 * The reason is the control. An unexplained entry on that list is how a
 * tenant-owned table gets parked there to make the build go green.
 */
export function findUnexplainedGlobalEntries(reasons: Readonly<Record<string, string>>): string[] {
  return Object.entries(reasons)
    .filter(([, reason]) => reason.trim().length === 0)
    .map(([name]) => name);
}

/**
 * Rule 4 — unsafe referential-integrity cascades into tenant-owned tables.
 *
 * A relation is in scope only when the **child** (the model the relation is
 * listed under, the one whose rows a cascade would destroy) is tenant-owned and
 * the **parent** is not tenant-scoped. A cascade from the tenant root is fine:
 * it can only ever stay inside the one tenant being deleted.
 *
 * An omitted `onDelete` is reported, not assumed. Measured against Prisma
 * 6.19.3: omitting `onDelete` leaves no `relationOnDelete` key on the DMMF
 * field, so the check cannot see a default it could evaluate. Prisma's default
 * depends on whether the relation field is optional (`SetNull`) or required
 * (`Restrict`), and only one of those is safe here. Reporting is the safe
 * direction — an omitted action must not silently pass a rule it would fail if
 * written out — and the cost is one word of schema per foreign key.
 */
export function findUnsafeCascades(
  models: readonly ModelInfo[],
  registries: Registries,
): CascadeViolation[] {
  const tenantOwned = new Set(registries.tenantOwned);
  const tenantScoped = new Set([...registries.tenantOwned, registries.tenantRoot]);

  return models
    .filter((model) => tenantOwned.has(model.name))
    .flatMap((model) =>
      (model.relations ?? [])
        .filter((relation) => !tenantScoped.has(relation.parentModel))
        .filter((relation) => relation.onDelete === undefined || relation.onDelete === 'Cascade')
        .map((relation) => ({
          model: model.name,
          field: relation.field,
          parentModel: relation.parentModel,
          kind: relation.onDelete === undefined ? ('undeclared' as const) : ('cascade' as const),
        })),
    );
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

const REGISTRY_FILE = 'packages/db/src/tenant-resources.ts';

function report(lines: readonly string[]): void {
  // This is a CI check whose entire output contract is what it prints to a
  // terminal; the structured logger's JSON is the wrong medium for a message
  // whose job is to be read by a human staring at a red build.
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

export function runChecks(
  models: readonly ModelInfo[],
  registries: Registries,
  globalReasons: Readonly<Record<string, string>>,
): string[] {
  const failures: string[] = [];

  for (const name of findUnregisteredTenantModels(models, registries.tenantOwned)) {
    failures.push(
      [
        `Model "${name}" carries ${TENANT_COLUMN} but is not in TENANT_OWNED_MODELS.`,
        '',
        'A tenant-owned table that is not registered will not be covered by the',
        'cross-tenant isolation harness. Add it to',
        `${REGISTRY_FILE}, enable RLS on it in a migration, and add`,
        'its cross-tenant assertions.',
        '',
        'See .claude/development/migrations.md §5.',
      ].join('\n'),
    );
  }

  for (const name of findStaleRegistryEntries(models, registries.tenantOwned)) {
    failures.push(
      [
        `Model "${name}" is in TENANT_OWNED_MODELS but does not carry ${TENANT_COLUMN}`,
        '(or no longer exists).',
        '',
        'A stale entry claims isolation coverage for something that no longer',
        'needs it, and hides that a table stopped being tenant-owned — which is',
        `itself worth a second look. Remove it from ${REGISTRY_FILE}`,
        'and account for the model under one of the other two registries.',
        '',
        'See .claude/security/tenant-isolation.md §4.',
      ].join('\n'),
    );
  }

  for (const name of findUnaccountedModels(models, registries)) {
    failures.push(
      [
        `Model "${name}" is in none of the three registries.`,
        '',
        'Every model must be accounted for by exactly one of TENANT_OWNED_MODELS,',
        'TENANT_ROOT_MODEL, or DELIBERATELY_GLOBAL_MODELS. A rule keyed on the',
        `${TENANT_COLUMN} column cannot see a tenant-scoped table that does not`,
        'carry it — Organization is exactly that — so "accounted for by someone"',
        'is the only rule that covers every model.',
        '',
        `Decide which it is and record it in ${REGISTRY_FILE}.`,
        'If it is deliberately global, the entry needs a reason.',
        '',
        'See .claude/security/tenant-isolation.md §1.',
      ].join('\n'),
    );
  }

  for (const name of findMultiplyAccountedModels(models, registries)) {
    failures.push(
      [
        `Model "${name}" is claimed by more than one registry.`,
        '',
        'Tenant-owned, tenant root, and deliberately global are exclusive claims.',
        `Remove the wrong one from ${REGISTRY_FILE}.`,
      ].join('\n'),
    );
  }

  for (const name of findUnknownRegistryEntries(models, registries)) {
    failures.push(
      [
        `Registry entry "${name}" names a model that is not in the Prisma datamodel.`,
        '',
        'Either the model was renamed or removed and the registry was not updated,',
        `or the entry is a typo. Fix ${REGISTRY_FILE}.`,
      ].join('\n'),
    );
  }

  for (const name of findUnexplainedGlobalEntries(globalReasons)) {
    failures.push(
      [
        `DELIBERATELY_GLOBAL_MODELS["${name}"] has no reason.`,
        '',
        'The reason is the control. An unexplained entry on that list is how a',
        'tenant-owned table gets parked there to make the build go green. Write',
        'one line saying why this model holds no data belonging to one',
        'organisation.',
      ].join('\n'),
    );
  }

  for (const violation of findUnsafeCascades(models, registries)) {
    const declared =
      violation.kind === 'cascade' ? `is ON DELETE CASCADE` : `does not declare onDelete at all`;
    failures.push(
      [
        `${violation.model}.${violation.field} -> ${violation.parentModel} ${declared}.`,
        '',
        `${violation.model} is tenant-owned and ${violation.parentModel} is not`,
        'tenant-scoped, so a delete there crosses the tenant boundary through',
        "Postgres's own referential-integrity machinery — which runs BELOW both",
        'row-level security and the tenant-scoped client, invisible to either.',
        'That is not hypothetical: Membership.userId was Cascade, and deleting a',
        "User destroyed every other organisation's Membership rows for them.",
        '',
        'This rule does NOT say every FK into a tenant-owned table must be',
        'RESTRICT. A cascade from Organization — the tenant root — is correct,',
        'because it can only ever stay inside the one tenant being deleted.',
        'Membership.organizationId and Invitation.organizationId are Cascade and',
        'are meant to be.',
        '',
        violation.kind === 'undeclared'
          ? 'An omitted onDelete is reported rather than assumed: Prisma does not\nput its default in the DMMF, and the default it would apply depends on\nwhether the field is optional. Declare it explicitly.'
          : 'Change it to onDelete: Restrict and write the migration.',
        '',
        'See .claude/security/tenant-isolation.md §2 (Layer 2).',
      ].join('\n'),
    );
  }

  return failures;
}

/**
 * `@sentinel/db` is imported dynamically, inside `main()`, on purpose.
 *
 * The package resolves to `packages/db/dist`, which only exists after
 * `pnpm build`. A static import would make `check-tenant-registry.spec.ts` —
 * which needs none of it, the functions above being pure — fail to even load in
 * the unit lane, which CI runs before the build. Measured: with
 * `packages/db/dist` moved aside, the spec still passes and this script still
 * fails with a resolution error, which is the split this shape buys.
 */
async function main(): Promise<void> {
  const {
    datamodelModels,
    DELIBERATELY_GLOBAL_MODEL_NAMES,
    DELIBERATELY_GLOBAL_MODELS,
    PRISMA_CLIENT_VERSION,
    TENANT_OWNED_MODELS,
    TENANT_ROOT_MODEL,
  } = await import('@sentinel/db');

  const models = datamodelModels();
  const registries: Registries = {
    tenantOwned: [...TENANT_OWNED_MODELS],
    tenantRoot: TENANT_ROOT_MODEL,
    deliberatelyGlobal: [...DELIBERATELY_GLOBAL_MODEL_NAMES],
  };

  const failures = runChecks(models, registries, DELIBERATELY_GLOBAL_MODELS);

  if (failures.length > 0) {
    report([
      `check:registry FAILED — ${String(failures.length)} problem(s).`,
      '',
      ...failures.flatMap((failure) => [failure, '', '---', '']),
    ]);
    process.exitCode = 1;
    return;
  }

  report([
    `check:registry OK — ${String(models.length)} models, ` +
      `${String(registries.tenantOwned.length)} tenant-owned, ` +
      `1 tenant root, ${String(registries.deliberatelyGlobal.length)} deliberately global ` +
      `(Prisma client ${PRISMA_CLIENT_VERSION}).`,
  ]);
}

// Only run when invoked as a script. The spec imports this module for its pure
// functions, and importing a module must not run a process-exiting check.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
