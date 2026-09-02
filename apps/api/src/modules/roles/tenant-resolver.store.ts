import { withTenantTransaction } from '@sentinel/db';
import type { TenantResolutionInput, TenantResolver } from '../../common/guards/tenant-context.js';
import { knownPermissions } from '../../common/guards/tenant-context.js';
import type { MfaEnrolmentPolicy } from '../auth/require-mfa.js';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one. The
 * same derivation `active-organization.store.ts` uses, for the same reason.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/**
 * ONE QUERY PER AUTHENTICATED REQUEST THAT NAMES AN ORGANISATION, AND NO CACHE.
 *
 * # Why there is no permission cache
 *
 * `product/permissions.md` invariant 4: "Changing a member's role takes effect
 * on their **next request** — the permission cache is invalidated on write, not
 * expired on a timer." A cache satisfies that invariant only for as long as
 * every writer remembers to invalidate it, and this phase's ledger is a list of
 * what happens to invariants maintained by remembering. Ruling 51 and ruling 82
 * are both the same shape: a write that had to happen in the right order
 * relative to another write, proved wrong by measurement, twice.
 *
 * Reading it fresh makes the invariant **structural**. There is no
 * `invalidate()` for Task 14's role change or Task 15's invitation acceptance
 * to forget, because there is nothing to invalidate: `Membership.roleId` is
 * read on the request that follows the write, by the transaction that follows
 * the write. The decision was put to the operator on 2026-09-02 with the cache
 * as the alternative, and this is what they chose.
 *
 * The cost is one indexed statement pair inside one transaction, and it is paid
 * only when `Session.activeOrganizationId` is non-null — which in Phase 2 is
 * never, because nothing writes that column until Task 13. Adding a cache later
 * is additive and needs a measurement this task does not have.
 *
 * # It runs inside `withTenantTransaction`, and that is the security control
 *
 * `Membership` is tenant-owned: it carries RLS keyed on `organizationId`, and
 * the tenant-scoping client extension injects the same predicate. `Organization`
 * carries `FORCE ROW LEVEL SECURITY` keyed on `id`. The `PRISMA` token is the
 * *unscoped* client and it connects as `sentinel_app`, the least-privileged
 * role, so `current_setting('app.organization_id', true)` is NULL outside a
 * tenant transaction and both reads return zero rows — see the measured
 * transcript in `active-organization.store.ts`, which found this exact trap by
 * mutation.
 *
 * That is also why the `where` below names `organizationId` explicitly even
 * though the extension would inject it. Two layers, both stated: the extension
 * scopes the top-level operation, RLS catches what the extension cannot see,
 * and the explicit predicate means a reader of this file does not have to know
 * about either to see which organisation is being asked about. It is not
 * redundant with the extension — `decideScope` is what makes the two agree, and
 * `tenant-client.integration.spec.ts` proves a mismatched explicit value is
 * refused rather than honoured.
 *
 * # Role and permissions come from the seeded rows, not from the constant
 *
 * `ROLE_PERMISSIONS` in `@sentinel/contracts` is the source the seed is built
 * *from*, and reading it here instead would make the seeded `RolePermission`
 * rows decorative — a drift between the two would be invisible, which is
 * carry-forward rulings 5, 13 and 27's family. `authorization.integration.spec.ts`
 * asserts the two agree for every system role, so the drift fails a test
 * instead.
 */
export function tenantResolver(base: TenantTransactionBase): TenantResolver {
  return ({
    userId,
    organizationId,
  }): Promise<Omit<TenantResolutionInput, 'activeOrganizationId'>> =>
    withTenantTransaction(base, organizationId, async (tx) => {
      // `findFirst`, not `findUnique`: the "at most one live membership per
      // (organizationId, userId)" rule is a PARTIAL unique index created by
      // hand (`Membership_organizationId_userId_active_key`), and Prisma cannot
      // see a partial index — carry-forward ruling 4 — so there is no generated
      // unique input to look it up by.
      //
      // `deletedAt: null` IS THE PREDICATE THAT MAKES THIS DETERMINISTIC, and
      // the first version of this query did not have it. The Task 12 review's
      // M-1: `(organizationId, userId)` is unique only **where `deletedAt` is
      // null**, so any number of `REMOVED` rows may coexist with the one live
      // row — which is exactly what Task 14's member removal followed by Task
      // 15's re-invitation produces. A `findFirst` with no predicate and no
      // `orderBy` emits `LIMIT 1` with no `ORDER BY`, and Postgres may return
      // any of them. Measured by the reviewer on a replayed schema: two
      // `REMOVED` rows plus one `ACTIVE` row returned a `REMOVED` one, which
      // `resolveTenant` reads as `not-a-member` — **a silent, non-deterministic
      // 404 on every guarded route for a member who is active.**
      //
      // With this predicate the partial unique index guarantees at most one
      // matching row, so there is nothing left for an `orderBy` to disambiguate.
      // The CHECK constraint `Membership_status_deletedAt_agree_check` makes
      // `("deletedAt" IS NULL) = (status <> 'REMOVED')` a database invariant, so
      // this also cannot hide a live `REMOVED` row: such a row cannot exist.
      // `status` is still read and still judged by `resolveTenant`, because
      // `INVITED` is inside this predicate and is not a membership.
      //
      // The comment that used to sit here said `deletedAt` was omitted because
      // "filtering on both would be filtering on one fact twice". The query
      // filtered on neither, so there was no "twice" — a false sentence
      // defending a real defect.
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId, deletedAt: null },
        select: {
          id: true,
          status: true,
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      });

      // `select: { status: true }` rather than the whole row: `Organization`
      // also carries `requireMfa` and `enforcedEmailDomain`, and a guard that
      // reads columns it does not act on is a guard whose next reader assumes
      // they are load-bearing (Task 8's L7).
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { status: true },
      });

      return {
        membership:
          membership === null
            ? null
            : {
                id: membership.id,
                isActive: membership.status === 'ACTIVE',
                // `SystemRoleKey` (Prisma) and `SystemRole` (contracts) are the
                // same seven values, and TypeScript agrees without an assertion
                // — which is only true while they agree. `enum-parity.spec.ts`
                // is what keeps that so: it cross-checks against
                // `Prisma.dmmf.datamodel.enums` and goes red when a value is
                // added to one side (carry-forward ruling 13). An `as
                // SystemRole` here would have hidden the divergence instead.
                roleKey: membership.role.key,
                permissions: knownPermissions(
                  membership.role.permissions.map((grant) => grant.permission.key),
                ),
              },
        // A NULL organisation is not an active one. Unreachable while the
        // `Membership.organizationId` foreign key holds, and answered rather
        // than thrown because the safe reading of "I cannot see the
        // organisation" is that the caller may not act in it.
        organizationIsActive: organization?.status === 'ACTIVE',
      };
    });
}

/**
 * D8's lookup port, discharged. "Does this organisation require MFA, and has
 * this member confirmed a factor?"
 *
 * Task 11 wrote `MfaEnrolmentGuard` and left this unprovided, saying the query
 * "needs organisation membership under tenant scoping, which is Task 12's".
 * This is it.
 *
 * **`MfaFactor` is user-owned and carries no RLS** — carry-forward ruling 9 —
 * so the factor read is deliberately outside the tenant transaction and keyed
 * on the `userId` the authentication guard put on the request. Ruling 9's
 * requirement is that a handler taking a `userId` from a request path prove the
 * caller is that user; this one takes it from the resolved session, which is
 * the proof.
 *
 * `confirmedAt: { not: null }` rather than a row count, per `RequireMfaInput`'s
 * own docblock and carry-forward ruling 7: an abandoned unconfirmed enrolment
 * is a row that exists, and counting rows would let a user satisfy an
 * organisation's MFA requirement by starting an enrolment and closing the tab.
 */
export function mfaEnrolmentPolicy(base: TenantTransactionBase): MfaEnrolmentPolicy {
  return async ({ userId, organizationId }) => {
    const organization = await withTenantTransaction(base, organizationId, (tx) =>
      tx.organization.findUnique({ where: { id: organizationId }, select: { requireMfa: true } }),
    );
    // Not read when no organisation requires it: an organisation that does not
    // require MFA cannot refuse the request whatever the answer is, and the
    // read would be one query per request on every route for a value nothing
    // consults.
    if (organization?.requireMfa !== true) {
      return { requireMfa: false, hasConfirmedFactor: false };
    }
    const factor = await base.mfaFactor.findFirst({
      where: { userId, confirmedAt: { not: null } },
      select: { id: true },
    });
    return { requireMfa: true, hasConfirmedFactor: factor !== null };
  };
}
