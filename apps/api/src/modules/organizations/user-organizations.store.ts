import type { OrganizationResponse, OrganizationStatus } from '@sentinel/contracts';
import { withTenantTransaction } from '@sentinel/db';
import { CURSOR_START, type ListCursor } from './list-cursor.js';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one. The
 * same derivation `active-organization.store.ts` and `tenant-resolver.store.ts`
 * use, for the same reason.
 *
 * Note that this file never opens a tenant transaction — see the docblock
 * below. `withTenantTransaction` is imported for its type alone.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/** One page of the caller's organisations, plus whether there is another. */
export interface UserOrganizationPage {
  readonly rows: readonly OrganizationResponse[];
  readonly hasMore: boolean;
}

export interface UserOrganizationLookup {
  find(input: {
    userId: string;
    limit: number;
    cursor: ListCursor | null;
  }): Promise<UserOrganizationPage>;
}

/**
 * The raw shape `user_organizations(text)` returns. Prisma's `$queryRaw` gives
 * back driver values, so the enum arrives as text and the timestamps as `Date`.
 */
interface UserOrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `OrganizationStatus` is the same three values on both sides, and this narrows
 * a driver string to the union without an `as`.
 *
 * A row whose status is not one of the three cannot exist — the column is a
 * Postgres enum — so the fallback is unreachable rather than lenient. It is
 * `SUSPENDED` rather than `ACTIVE` because the fail-closed direction for an
 * unrecognised state is the one that shows the caller less, not more.
 */
const ORGANIZATION_STATUS_VALUES: ReadonlySet<string> = new Set<OrganizationStatus>([
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED',
]);

function toStatus(value: string): OrganizationStatus {
  return ORGANIZATION_STATUS_VALUES.has(value) ? (value as OrganizationStatus) : 'SUSPENDED';
}

/**
 * ADR-0020, AS THE ONLY QUERY IN THIS PRODUCT THAT SPANS ORGANISATIONS.
 *
 * # Why it is not `prisma.membership.findMany({ where: { userId } })`
 *
 * That returns an empty list for every user who has organisations. `Membership`
 * carries `ENABLE`/`FORCE ROW LEVEL SECURITY` with the policy
 * `"organizationId" = current_setting('app.organization_id', true)`, the API
 * connects as `sentinel_app`, which has neither `SUPERUSER` nor `BYPASSRLS`,
 * and there is no tenant transaction to open — the question is *which*
 * organisations, and you cannot scope a query to an organisation you are trying
 * to discover. Measured against the compose Postgres on 2026-09-02 for a user
 * holding two `ACTIVE` memberships: zero rows.
 *
 * So this is a `SECURITY DEFINER` function owned by `sentinel_org_lookup`, a
 * `NOLOGIN NOINHERIT BYPASSRLS` role that exists only to own it. The full
 * argument, the measurements and the two alternatives that lose are in
 * ADR-0020 and in `20260902083622_organization_lookup_function/migration.sql`.
 *
 * # What contains the bypass
 *
 * **The predicate is fixed in the function body.** The only thing a call site
 * supplies is a user id: the membership filter (`deletedAt IS NULL`,
 * `status = 'ACTIVE'`), the join and the column list are all inside a migration
 * and cannot be widened from here. What the SQL below adds is an ordering and a
 * window — it can only ever show *fewer* of the caller's own organisations,
 * never anybody else's.
 *
 * **`userId` comes from the authenticated session and from nowhere else.**
 * Carry-forward ruling 9's rule for a user-owned read: a handler taking a
 * `userId` from a request must prove the caller is that user, and taking it
 * from `request.principal` — which `AuthenticationGuard` resolved from the
 * session cookie — is the proof. There is no path parameter, query field or
 * body key on this endpoint that reaches this argument, and
 * `organizations.integration.spec.ts` pins that a caller receives their own
 * organisations and not another user's.
 *
 * # It runs on the base client, outside any transaction, and that is correct
 *
 * Every other read in this codebase that touches `Organization` or `Membership`
 * goes through `withTenantTransaction`, and the two files that do say loudly
 * that it is not optional. This one is the documented exception: there is no
 * organisation to scope to. The function's own `WHERE` clause is layer 1, and
 * ADR-0020 states plainly that for this one query layer 2 is deliberately
 * switched off. `security/tenant-isolation.md` records it as an exception
 * rather than leaving a reader to infer that the rule has holes.
 *
 * # Keyset pagination, one statement, no branch
 *
 * `api/pagination.md` §1's shape: `ORDER BY "createdAt" DESC, id DESC` with the
 * id as the tie-breaker, and `LIMIT n + 1` so `hasMore` costs no second query.
 * The first page passes `CURSOR_START` — `('infinity', '')` — which every real
 * row compares below, so page one and page nine are the same statement. See
 * `list-cursor.ts`.
 */
export function userOrganizationLookup(base: TenantTransactionBase): UserOrganizationLookup {
  return {
    find: async ({ userId, limit, cursor }) => {
      const from = cursor ?? CURSOR_START;
      // Parameterised throughout: every interpolation below is a Prisma
      // placeholder, not string concatenation. `$queryRaw` (tagged template),
      // never `$queryRawUnsafe`.
      const rows = await base.$queryRaw<UserOrganizationRow[]>`
        SELECT id, slug, name, status, "createdAt", "updatedAt"
        FROM user_organizations(${userId})
        WHERE ("createdAt", id) < (${from.createdAt}::timestamptz, ${from.id})
        ORDER BY "createdAt" DESC, id DESC
        LIMIT ${limit + 1}
      `;

      // The extra row is the `hasMore` signal and is never returned. Slicing
      // after the read rather than issuing `LIMIT n` plus a `COUNT` is §1's own
      // "one extra row determines hasMore without a second query".
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        hasMore,
        rows: page.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: toStatus(row.status),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    },
  };
}
