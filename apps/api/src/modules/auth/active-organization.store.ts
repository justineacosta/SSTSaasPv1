import { withTenantTransaction } from '@sentinel/db';
import type { SessionOrganization } from '@sentinel/contracts';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one
 * (`eslint.config.js` says so in the exemption beside `packages/db/src/unscoped.ts`).
 * Widening that fence for a type name would be a worse trade than deriving the
 * type from the one function in this file that is allowed to take it.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/**
 * The narrow port `GET /api/v1/auth/session` uses to name the organisation a
 * session is currently acting in.
 *
 * One method, one question. The alternative — handing the session handler the
 * whole Prisma client — is what `IdentityStore`, `SessionStore` and
 * `VerificationTokenStore` all exist to avoid, and it would additionally hand a
 * handler the ability to read organisations it was not asked about.
 */
export interface ActiveOrganizationLookup {
  find(organizationId: string): Promise<SessionOrganization | null>;
}

/**
 * THE LOOKUP RUNS INSIDE A TENANT TRANSACTION, AND THAT IS NOT OPTIONAL.
 * MEASURED, NOT REASONED.
 *
 * `Organization` carries `FORCE ROW LEVEL SECURITY` with the policy
 * `USING/WITH CHECK ("id" = current_setting('app.organization_id', true))`
 * (`20260820132520_tenant_root_and_audit_restrict/migration.sql` — the tenant
 * root has no `organizationId` column, so its policy is keyed on `id`). The
 * `PRISMA` token is the *unscoped* client and it connects as `sentinel_app`,
 * the least-privileged role, so `current_setting(...)` returns NULL, `"id" =
 * NULL` is NULL, and **the query returns zero rows for every organisation that
 * exists.**
 *
 * Measured against the compose Postgres on 2026-08-31, after inserting one row
 * as the schema owner:
 *
 * ```
 * -- as sentinel_app, no app.organization_id
 * SELECT id, slug, name FROM "Organization" WHERE id = 'org_probe_task9';
 *  id | slug | name
 * ----+------+------
 * (0 rows)
 *
 * -- as sentinel_app, SET app.organization_id = 'org_probe_task9'
 *        id        |    slug     |   name
 * -----------------+-------------+-----------
 *  org_probe_task9 | probe-task9 | Probe Org
 * (1 row)
 * ```
 *
 * So a plain `prisma.organization.findUnique` here would compile, pass review,
 * pass every integration test in this repository — the harness connects as the
 * container's owner role, which is a superuser and bypasses RLS — and return
 * `null` in production for every session that had an organisation. That is the
 * exact shape of carry-forward ruling 58: a check whose fixtures all sit on one
 * side of the branch under test. `auth.session.integration.spec.ts` therefore
 * drives this lookup over a **second client bound to the harness's `appUrl`**,
 * which is `sentinel_app` under the same RLS the production process runs under.
 *
 * `withTenantTransaction` is Phase 1's mechanism for exactly this and it is
 * already tested (`tenant-transaction.integration.spec.ts`): it extends the
 * client with the tenant-scoping extension and issues
 * `set_config('app.organization_id', ..., true)` as the transaction's first
 * statement, so both layers — the extension and the policy — are live.
 * `SET LOCAL` semantics mean a pooled connection cannot inherit the setting.
 *
 * **This is not tenant resolution.** Task 12 owns deciding whether the caller
 * is *entitled* to that organisation, from their `Membership`. What happens
 * here is narrower and is safe without it: the id comes from
 * `Session.activeOrganizationId`, a column only this application writes, and
 * the row read back is scoped to that same id. Nothing widens.
 *
 * # What it costs
 *
 * One interactive transaction, one `set_config`, and one primary-key lookup —
 * on `GET /auth/session` only, and only when `activeOrganizationId` is non-null.
 * **Today that is never**: nothing in Phase 2 writes that column until Task 13,
 * so the live cost is one `if` and the code below does not execute. It is built
 * now rather than stubbed because an unimplemented lookup is a lookup Task 13
 * has to discover is missing, and it would discover it as a `null` that looks
 * exactly like "this user has not chosen an organisation".
 */
export function activeOrganizationLookup(base: TenantTransactionBase): ActiveOrganizationLookup {
  return {
    find: (organizationId) =>
      withTenantTransaction(base, organizationId, async (tx) =>
        // `select`, not the whole row. `sessionResponseSchema` publishes exactly
        // `id`, `slug` and `name`, and `Organization` also carries `status`,
        // `requireMfa` and `enforcedEmailDomain` — three columns a page has no
        // business receiving because a response schema happened to strip them.
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, slug: true, name: true },
        }),
      ),
  };
}
