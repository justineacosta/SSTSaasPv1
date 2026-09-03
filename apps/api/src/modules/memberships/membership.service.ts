import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  LIST_LIMIT_MAX,
  PERMISSIONS,
  type MembershipCollection,
  type MembershipResponse,
  type Permission,
  type SystemRole,
  type TenantContext,
} from '@sentinel/contracts';
import { withTenantTransaction } from '@sentinel/db';
import { permissionDenied } from '../../common/guards/authorization.guard.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRequestContext } from '../auth/request-context.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { encodeListCursor, type ListCursor } from '../organizations/list-cursor.js';
import { assertPathIsActiveTenant, notFound } from '../organizations/organization.service.js';
import { MEMBER_SESSION_REVOKER, type MemberSessionRevoker } from './memberships.tokens.js';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one. The
 * same derivation `tenant-resolver.store.ts` uses, for the same reason.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/** The transaction handle `withTenantTransaction` yields. */
type TenantTransaction = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

export interface ListMembershipsCommand {
  readonly limit: number;
  readonly cursor: ListCursor | null;
}

export interface UpdateMembershipRoleCommand extends AuthRequestContext {
  readonly actorUserId: string;
  readonly roleKey: SystemRole;
}

export interface RemoveMembershipCommand extends AuthRequestContext {
  readonly actorUserId: string;
}

/**
 * THE COLUMNS `membershipResponseSchema` PUBLISHES, AND NO OTHERS.
 *
 * The user projection is `membershipUserSchema` exactly — id, email, name.
 * `User` also carries `lastLoginAt`, `failedLoginCount`, `lockedUntil` and
 * `status`, and those are the account owner's business rather than their
 * colleagues'. Written once and shared by the three reads rather than repeated,
 * for the reason `ORGANIZATION_COLUMNS` gives: a column added to the response
 * then has one place to be added rather than three.
 *
 * One `select` with a nested relation is one query, not one per row — Prisma
 * emits a join for `select` on a to-one relation — so the list endpoint has no
 * N+1 to assert away.
 *
 * **Exported for Task 15's acceptance handler**, which creates a `Membership`
 * and returns it through `acceptInvitationResponseSchema` — which *is*
 * `membershipResponseSchema` (`packages/contracts/src/invitations.ts`). Two
 * column lists feeding one wire schema is how the two drift, so there is one.
 */
export const MEMBERSHIP_COLUMNS = {
  id: true,
  organizationId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { key: true } },
  user: { select: { id: true, email: true, name: true } },
} as const;

/**
 * The refusal for "this write would leave the organisation with no owner".
 *
 * 422 rather than 409: `api/conventions.md` §2 gives 422 to a request whose
 * shape is valid and which fails a domain rule, which is exactly this — the
 * body parsed, the membership exists, the caller holds the permission, and the
 * rule refuses. `INVALID_STATE_TRANSITION` is the code `api/errors.md` maps
 * that onto.
 */
function lastOwner(action: 'demoted' | 'removed'): DomainError {
  return new DomainError(
    ERROR_CODES.INVALID_STATE_TRANSITION,
    `An organisation must always have at least one owner, so its last owner cannot be ${action}. ` +
      'Give another member the owner role first.',
    422,
  );
}

/**
 * D1 — THE LOCK, AND WHY IT IS THE MECHANISM RATHER THAN A SECOND COUNT.
 *
 * `product/permissions.md` invariant 1: an organisation always has at least one
 * `OWNER`. The naive enforcement is "count the owners, then write", and it is
 * worthless under concurrency: two transactions demoting the two remaining
 * owners each count **under their own snapshot**, each see two, and both
 * commit. `last-owner.integration.spec.ts` runs exactly that against real
 * Postgres and measures the organisation ending with zero owners — which is
 * what makes the locked version's green tick mean something.
 *
 * The alternatives, so nobody re-derives them:
 *
 * - **A CHECK constraint cannot express it.** "At least one row matching X
 *   exists" is not a row-level predicate and Postgres has no declarative form
 *   for it.
 * - **A trigger alone does not close the race**, for the same snapshot reason:
 *   each transaction's trigger counts what its own snapshot can see. The
 *   snapshot is the problem, not where the check is written.
 * - **`SERIALIZABLE` closes it and is rejected.** It aborts one transaction
 *   with `40001`, which needs a retry loop; an unhandled `40001` is a 500 on a
 *   routine role change. The lock serialises the same window with no retry and
 *   no new failure mode.
 *
 * Taken on the tenant root rather than on the `Membership` rows because the
 * invariant is a property of the **set**, and a row lock cannot be taken on a
 * row that does not exist yet — a concurrent promotion inserting a new OWNER is
 * inside the window this must cover. One row per tenant, held for one short
 * transaction.
 *
 * **Every membership write that can change the owner count takes it**, which
 * today is the role change and the removal below, and tomorrow is Task 15's
 * invitation acceptance. A writer that skips it is outside the serialisation
 * and reopens the race for everyone.
 *
 * Issued as raw SQL because Prisma has no `FOR UPDATE`. It is parameterised —
 * `$queryRaw` is a tagged template — and it runs inside `withTenantTransaction`,
 * so `Organization`'s RLS policy (`id = current_setting('app.organization_id')`)
 * is live for it as well: the only row this statement can reach is the tenant's
 * own.
 *
 * A zero-row result means the organisation vanished between the guard's
 * resolution and this statement. 404 is the honest answer to that, not a 500.
 *
 * # IT IS TAKEN BEFORE THE MEMBERSHIP IS RESOLVED, AND THAT ORDER IS THE POINT
 *
 * Both callers take this lock as their **first** statement and read the
 * membership second, so a request naming a membership id that does not exist
 * still takes `FOR UPDATE` on the tenant row — for the length of a transaction
 * that then ends immediately with a 404. A caller holding
 * `organization.manage_roles` or `organization.manage_members` can therefore
 * serialise the tenant's membership writes by hammering ids that do not exist.
 * Noted, measured against the alternative, and kept.
 *
 * The alternative — resolve the membership first, lock second — reopens the
 * window this lock exists to close, because the owner count would then be read
 * outside it, and a count from the wrong snapshot is precisely the defect D1
 * rejects. The cost of the ordering is a privileged caller holding a per-tenant
 * lock for the duration of a 404; the cost of reversing it is the anomaly the
 * first test in `last-owner.integration.spec.ts` measures.
 *
 * **Do not "optimise" this into a conditional lock.** A branch that decides
 * when to lock is a branch that can be wrong, and an unexplained
 * lock-before-read is exactly the shape a later reader tidies away.
 *
 * # It is EXPORTED, and the third taker is invitation acceptance
 *
 * The sentence above — "tomorrow is Task 15's invitation acceptance" — is now
 * today. `InvitationService.accept` creates a `Membership`, which changes the
 * owner count whenever the invitation offered `OWNER`, so it is inside the set
 * this lock serialises and a writer that skipped it would reopen the race for
 * everybody else. It imports this function rather than writing a second one,
 * for the reason D5 gives for `assertActorMayGrant`: two functions taking
 * "the organisation lock" are two locks the day one of them is edited.
 */
export async function lockOrganization(
  tx: TenantTransaction,
  organizationId: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE
  `;
  if (locked.length === 0) throw notFound();
}

/**
 * The live membership the path names, or 404.
 *
 * **`deletedAt: null` is load-bearing and is carry-forward ruling 99.**
 * `(organizationId, userId)` is unique only `WHERE "deletedAt" IS NULL`, so a
 * member who has been removed and re-added has several rows for one pair and
 * only one of them is live. Without the predicate this read can return a
 * `REMOVED` row — non-deterministically, because a small table is seq-scanned
 * in physical order — and the endpoint would then refuse a role change to a
 * member who is active, or "remove" somebody who was already gone.
 *
 * It is also what makes an already-removed membership a **404 rather than a
 * 204**: removal is not idempotent here, because a second removal of a row that
 * no longer exists would write a second `MEMBER_REMOVED` audit event for one
 * departure.
 *
 * `organizationId` is named explicitly although the tenant-scoping extension
 * would inject it and RLS would refuse the row anyway. Three layers, all
 * stated, for the reason `tenant-resolver.store.ts` gives: a reader of this file
 * should not have to know about either of the other two to see which
 * organisation is being asked about.
 */
async function liveMembership(
  tx: TenantTransaction,
  organizationId: string,
  membershipId: string,
): Promise<{
  id: string;
  userId: string;
  status: 'ACTIVE' | 'INVITED' | 'REMOVED';
  roleKey: SystemRole;
}> {
  const membership = await tx.membership.findFirst({
    where: { id: membershipId, organizationId, deletedAt: null },
    select: { id: true, userId: true, status: true, role: { select: { key: true } } },
  });
  if (membership === null) throw notFound();
  return {
    id: membership.id,
    userId: membership.userId,
    status: membership.status,
    roleKey: membership.role.key,
  };
}

/**
 * Refuses a write that would take the organisation's live owner count to zero.
 *
 * Counted **inside the caller's lock**, and counted once: the query excludes the
 * row being written, so the before and after counts are both derived from one
 * statement rather than from two reads that could disagree.
 *
 * `status: 'ACTIVE'` as well as `deletedAt: null`, because the two are not the
 * same fact. The CHECK constraint ties `REMOVED` to soft-deleted, but `INVITED`
 * is neither — an invited member holding the `OWNER` role is not yet an owner of
 * anything, and counting them would let an organisation's only real owner leave
 * on the strength of an invitation nobody has accepted.
 *
 * **`deletedAt: null` here is a KNOWN SURVIVING MUTATION, and it is stated
 * rather than removed.** Deleting it turns nothing red, because
 * `Membership_status_deletedAt_agree_check` makes `status = 'ACTIVE'` imply
 * `deletedAt IS NULL` — so no test can distinguish the two predicates while the
 * constraint holds, and a test written to try would be a test of the
 * constraint, which `membership-soft-delete.integration.spec.ts` already owns.
 * It stays because every other `Membership` read in this file carries it
 * (ruling 99) and a count that did not would read as an oversight; and because
 * the day someone relaxes the constraint, this predicate is the difference
 * between an owner count and a guess.
 *
 * **The refusal fires only when the write is what breaks the invariant.** An
 * organisation that already has no live owner — which nothing in this API can
 * produce, since creation mints one in the same transaction — is not made worse
 * by removing a `VIEWER`, and refusing that would be a lock-out with no
 * recovery path.
 */
async function assertOrganizationKeepsAnOwner(
  tx: TenantTransaction,
  organizationId: string,
  subject: {
    membershipId: string;
    isOwnerNow: boolean;
    isOwnerAfter: boolean;
    action: 'demoted' | 'removed';
  },
): Promise<void> {
  const others = await tx.membership.count({
    where: {
      organizationId,
      id: { not: subject.membershipId },
      status: 'ACTIVE',
      deletedAt: null,
      role: { key: 'OWNER' },
    },
  });

  const before = others + (subject.isOwnerNow ? 1 : 0);
  const after = others + (subject.isOwnerAfter ? 1 : 0);
  if (after === 0 && before > 0) throw lastOwner(subject.action);
}

/**
 * D5 — YOU CANNOT GRANT A ROLE WHOSE PERMISSIONS YOU DO NOT HOLD.
 *
 * `security/authorization.md` §4's rule, written there for custom roles: "may
 * hold any subset of permissions the creator themselves holds — you cannot mint
 * authority you do not possess". It binds a role change for exactly the same
 * reason, and the concrete case is not hypothetical: an `ADMIN` holds
 * `organization.manage_roles` but not `organization.delete`, so without this
 * check any `ADMIN` could promote a colleague to `OWNER` and have them delete
 * the organisation — or promote themselves through a second account.
 *
 * **A set comparison, deliberately, and not a role ranking.** A ranking
 * (`OWNER > ADMIN > ...`) is a second model of authority sitting beside
 * `ROLE_PERMISSIONS`, and the two drift the first time a permission moves
 * between roles. The set comparison cannot drift because it reads the same
 * seeded rows the authorization guard decides against.
 *
 * The granted role's permissions come from the seeded `RolePermission` rows
 * rather than from `ROLE_PERMISSIONS` in `@sentinel/contracts`, so both sides of
 * this comparison have the same origin as `ctx.permissions`.
 * `authorization.integration.spec.ts` is what keeps the seeded rows and the
 * constant in step.
 *
 * The refusal is built by `permissionDenied` — the same function
 * `AuthorizationGuard` uses — so a client sees one `PERMISSION_DENIED` shape
 * whether the refusal came from the guard or from here. The permission it names
 * is the first missing one **in `PERMISSIONS` order**, which makes the message
 * deterministic; the seeded rows come back in whatever order Postgres returns
 * them, and a message that varied run to run would be untestable.
 *
 * # IT HAS TWO CALLERS, AND THE SECOND ONE IS REMOVAL
 *
 * D5 as the brief wrote it binds the role change only, and Task 14 shipped it
 * that way. The review found the asymmetry that makes that incoherent: an
 * `ADMIN` could not **make** an `OWNER` and could **unmake** one, and could not
 * undo it — the removed owner cannot restore themselves and no `ADMIN` can
 * promote a replacement. `security/authorization.md` §4's principle is "you
 * cannot mint authority you do not possess", and an action a principal can take
 * but cannot reverse from inside their own authority wants a rule.
 *
 * So `remove` asks the same question of the role the **target** holds: an actor
 * may not remove a member whose role carries a permission the actor does not
 * hold. One helper, not two, and a set comparison rather than a ranking for the
 * reason above — a ranking is a second model of authority that drifts from
 * `ROLE_PERMISSIONS`.
 *
 * The ordinary cases are not bricked by it, and they are the ones to check
 * before reading the tests: `OWNER` removing `OWNER` is equal sets and passes;
 * `ADMIN` removing `ADMIN` passes; `ADMIN` removing anything weaker passes; and
 * self-removal is always equal sets, so it passes for every role. What is
 * refused is an actor reaching **upwards** — `ADMIN` removing `OWNER` is 403.
 */
export function assertActorMayGrant(ctx: TenantContext, granted: readonly string[]): void {
  const missing = granted.filter(
    (key): key is Permission =>
      (PERMISSIONS as readonly string[]).includes(key) && !ctx.permissions.has(key as Permission),
  );
  if (missing.length === 0) return;

  const rank = (permission: Permission): number => PERMISSIONS.indexOf(permission);
  const required = [...missing].sort((a, b) => rank(a) - rank(b))[0];
  // Unreachable — `missing` is non-empty — and written as a branch rather than
  // an assertion so the type holds without one.
  if (required === undefined) return;
  throw permissionDenied(required, ctx);
}

/**
 * MEMBERSHIPS: LIST, CHANGE A ROLE, REMOVE.
 *
 * # Every write is one transaction, the audit row is inside it, and the lock is
 * the first statement in it
 *
 * `CLAUDE.md` rule 10 and `security/audit.md` §2: if the change rolls back so
 * does the event. `AuditService.record` takes the transaction handle instead of
 * opening one, so there is no way to write an event for a change that then
 * failed.
 *
 * The lock is taken before anything is read, not after, because a count taken
 * before the lock is a count from the wrong snapshot — which is the whole
 * defect D1 exists to close.
 *
 * # It holds the base client and every statement is wrapped
 *
 * `PRISMA` is the *unscoped* client, connecting as `sentinel_app`. `Membership`
 * carries RLS keyed on `organizationId` and `Organization` carries `FORCE ROW
 * LEVEL SECURITY` keyed on `id`, so a bare read on this client returns zero
 * rows. Every method below runs inside `withTenantTransaction`, which sets
 * `app.organization_id` and brings both isolation layers live.
 *
 * # Session revocation happens AFTER the transaction commits, and that is the
 * right order
 *
 * `permissions.md` invariant 5. Revoking inside the transaction would revoke
 * the sessions of a member whose removal then rolled back — a live account
 * signed out by a write that never happened. Revoking after means the reverse
 * risk: a removal that commits and a revocation that fails. That direction is
 * survivable and this one is not, because **the removal takes effect on the
 * next request whether or not the revocation ran**: there is no permission
 * cache (carry-forward ruling 94), so `TenantContextGuard` re-reads the
 * membership on every request naming an organisation and answers 404 the moment
 * the row is soft-deleted. The revocation is what makes the *session* dead
 * rather than merely powerless, and it is not the only thing standing between a
 * removed member and the organisation's data.
 */
@Injectable()
export class MembershipService {
  constructor(
    @Inject(PRISMA) private readonly base: TenantTransactionBase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MEMBER_SESSION_REVOKER) private readonly revokeSessions: MemberSessionRevoker,
  ) {}

  /**
   * `GET /api/v1/organizations/:id/members` — the live members, newest first.
   *
   * **The clamp and the echo are one feature**, exactly as on
   * `GET /organizations`: `listQuerySchema` clamps a limit above
   * `LIST_LIMIT_MAX` rather than rejecting it, and `pagination.limit` reports
   * the limit that was applied, without which a client asking for 500 cannot
   * tell 100 rows from "100 is all there was". Clamped here as well as in the
   * schema because `pagination.limit` is a claim about what this method did.
   *
   * Keyset pagination on `(createdAt, id)` descending. The id tie-breaker is not
   * optional (`api/pagination.md` §1): memberships written by one transaction
   * share a timestamp, so ordering on `createdAt` alone silently skips or
   * repeats rows.
   *
   * **The cursor's `createdAt` reaches Postgres as a `Date` this process
   * constructed**, not as the client's string — carry-forward ruling 111.
   * `decodeListCursor` already re-serialises what the client sent, and passing
   * `new Date(...)` to Prisma re-parses it a third time with the same parser,
   * so there is no pair of parsers here that can disagree. `CURSOR_START`, the
   * `'infinity'` sentinel the organisations list uses to keep one SQL statement
   * for both pages, is deliberately NOT used: `new Date('infinity')` is an
   * invalid date, and Prisma's `where` is composed in TypeScript here rather
   * than written as SQL, so the first page simply omits the predicate.
   *
   * `meta.total` is absent, per `api/pagination.md` §3 — exact counts are opt-in
   * behind `?includeTotal=true` and `listMembershipsQuerySchema` carries no such
   * field.
   */
  async list(
    ctx: TenantContext,
    pathId: string,
    command: ListMembershipsCommand,
  ): Promise<MembershipCollection> {
    assertPathIsActiveTenant(ctx, pathId);

    const limit = Math.min(command.limit, LIST_LIMIT_MAX);
    const cursor = command.cursor;
    const rows = await withTenantTransaction(this.base, ctx.organizationId, (tx) =>
      tx.membership.findMany({
        where: {
          organizationId: ctx.organizationId,
          // Ruling 99. A removed member is not a member, and the partial unique
          // index guarantees one live row per (organisation, user) only under
          // this predicate.
          deletedAt: null,
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // One more than asked for, so `hasMore` is a fact about the data rather
        // than a second `count` that could disagree with the page.
        take: limit + 1,
        select: MEMBERSHIP_COLUMNS,
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toMembershipResponse),
      pagination: {
        nextCursor:
          hasMore && last !== undefined
            ? encodeListCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
        hasMore,
        limit,
      },
    };
  }

  /**
   * `PATCH /api/v1/organizations/:id/members/:membershipId` — the role, and
   * nothing else.
   *
   * `updateMembershipRequestSchema` carries `roleKey` alone. `status` is
   * deliberately absent: removal is a soft delete and the CHECK constraint
   * `Membership_status_deletedAt_agree_check` makes `REMOVED` and soft-deleted
   * one fact, so exposing the column would invite a client to ask for half of a
   * two-column invariant.
   *
   * The order of the four refusals is deliberate and is the order a caller
   * learns the least from:
   *
   * 1. the path id against the resolved tenant (404 — the caller learns nothing
   *    about whether the organisation exists);
   * 2. the membership, live, inside this tenant (404 — same, for the member);
   * 3. D5's no-minting check (403 — about the caller's own authority, which
   *    they already know);
   * 4. the last-owner invariant (422 — about the organisation's state, which a
   *    member holding `organization.manage_roles` may see).
   *
   * **A role change to the role the member already holds is applied and
   * audited** rather than refused. It is a request that can be satisfied, the
   * end state is the one asked for, and the event records `before` and `after`
   * so a reader can see it changed nothing. Refusing it would mean a client
   * retrying after a dropped response gets an error for a request that
   * succeeded.
   */
  async updateRole(
    ctx: TenantContext,
    pathId: string,
    membershipId: string,
    command: UpdateMembershipRoleCommand,
  ): Promise<MembershipResponse> {
    assertPathIsActiveTenant(ctx, pathId);

    return withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
      await lockOrganization(tx, ctx.organizationId);

      const membership = await liveMembership(tx, ctx.organizationId, membershipId);

      // `Role` is deliberately-global reference data with no RLS, seeded by
      // `pnpm db:seed`. `findUniqueOrThrow` rather than `findUnique`: `roleKey`
      // has already been parsed against `systemRoleSchema`, so a missing row is
      // an unseeded database — a deployment fault, not a client error.
      const granted = await tx.role.findUniqueOrThrow({
        where: { key: command.roleKey },
        select: {
          id: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      });

      assertActorMayGrant(
        ctx,
        granted.permissions.map((grant) => grant.permission.key),
      );

      await assertOrganizationKeepsAnOwner(tx, ctx.organizationId, {
        membershipId,
        isOwnerNow: membership.status === 'ACTIVE' && membership.roleKey === 'OWNER',
        isOwnerAfter: membership.status === 'ACTIVE' && command.roleKey === 'OWNER',
        action: 'demoted',
      });

      // BOTH PREDICATES, STATED. Carry-forward ruling 99 and the reason
      // `assertOrganizationKeepsAnOwner`'s docblock gives for its own copy: every
      // `Membership` statement in this file names the organisation and excludes
      // the soft-deleted, and one that did not would read as an oversight. The
      // row was resolved live by `liveMembership` a few lines up, inside this
      // transaction and under the organisation lock, and the only writer that
      // can soft-delete it is `remove`, which takes the same lock — so a
      // `P2025` here is unreachable rather than handled. If a later writer skips
      // the lock, this write fails loudly instead of updating a removed row.
      const updated = await tx.membership.update({
        where: { id: membershipId, organizationId: ctx.organizationId, deletedAt: null },
        data: { roleId: granted.id },
        select: MEMBERSHIP_COLUMNS,
      });

      await this.audit.record(tx, {
        organizationId: ctx.organizationId,
        actorType: 'USER',
        actorId: command.actorUserId,
        action: 'ROLE_CHANGED',
        resourceType: 'Membership',
        resourceId: membershipId,
        // The plan's own words: "with before/after role in metadata".
        // `memberUserId` as well, because a membership id is meaningless to
        // somebody reading the trail six months later and the row it names may
        // by then be one of several for the same person.
        metadata: {
          before: membership.roleKey,
          after: command.roleKey,
          memberUserId: membership.userId,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      return toMembershipResponse(updated);
    });
  }

  /**
   * `DELETE /api/v1/organizations/:id/members/:membershipId` — a soft delete,
   * then the session revocation.
   *
   * **D3: `status` and `deletedAt` are written together, always.**
   * Carry-forward ruling 10 and the CHECK constraint
   * `Membership_status_deletedAt_agree_check`, which makes
   * `("deletedAt" IS NULL) = (status <> 'REMOVED')` a database invariant — a
   * bare `status: 'REMOVED'` is an invalid write and so is a bare `deletedAt`.
   * The soft delete is what Task 1's partial unique index exists for: it is what
   * lets the same person be re-added afterwards.
   *
   * `updateMany` rather than `update`, so a row that disappeared between the
   * read and the write is a zero count rather than a `P2025` this method would
   * have to recognise structurally. Inside the organisation lock nothing can
   * take it, which is why the branch is a 404 and not a retry.
   *
   * **204 with no body**, per `api/conventions.md` §2. There is nothing to
   * return: the membership the caller named no longer exists in the sense the
   * API means by "member".
   *
   * **Self-removal is supported**, and it is supported rather than tolerated.
   * Leaving an organisation is a legitimate action; the last-owner invariant
   * refuses the only dangerous case, which is the sole owner walking out (422);
   * and the same call revokes the leaver's sessions for this tenant, which is
   * the correct end state. Ruling 95 is satisfied — their sessions elsewhere and
   * their account survive. The authority check above never refuses it, because
   * an actor's own role is always an equal set to itself.
   *
   * The order of the four refusals mirrors `updateRole`'s and for the same
   * reason: path id (404), membership (404), the authority check (403), the
   * last-owner invariant (422).
   */
  async remove(
    ctx: TenantContext,
    pathId: string,
    membershipId: string,
    command: RemoveMembershipCommand,
  ): Promise<void> {
    assertPathIsActiveTenant(ctx, pathId);

    const removedUserId = await withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
      await lockOrganization(tx, ctx.organizationId);

      const membership = await liveMembership(tx, ctx.organizationId, membershipId);

      // D5's rule, pointed at the role the TARGET holds rather than at one being
      // granted. See `assertActorMayGrant`'s docblock for why removal asks the
      // same question as a role change. Read from the seeded `RolePermission`
      // rows, like the role change's own read, so both sides of the comparison
      // have the same origin as `ctx.permissions`.
      const held = await tx.role.findUniqueOrThrow({
        where: { key: membership.roleKey },
        select: { permissions: { select: { permission: { select: { key: true } } } } },
      });
      assertActorMayGrant(
        ctx,
        held.permissions.map((grant) => grant.permission.key),
      );

      await assertOrganizationKeepsAnOwner(tx, ctx.organizationId, {
        membershipId,
        isOwnerNow: membership.status === 'ACTIVE' && membership.roleKey === 'OWNER',
        isOwnerAfter: false,
        action: 'removed',
      });

      const written = await tx.membership.updateMany({
        where: { id: membershipId, organizationId: ctx.organizationId, deletedAt: null },
        // D3. Both columns, in one statement, because the constraint refuses
        // either on its own.
        data: { status: 'REMOVED', deletedAt: new Date() },
      });
      if (written.count === 0) throw notFound();

      await this.audit.record(tx, {
        organizationId: ctx.organizationId,
        actorType: 'USER',
        actorId: command.actorUserId,
        action: 'MEMBER_REMOVED',
        resourceType: 'Membership',
        resourceId: membershipId,
        // `after: null` rather than the string "REMOVED": the member holds no
        // role in this organisation any more, and `ROLE_CHANGED`'s metadata
        // uses the same two keys so one reader can read both events.
        metadata: {
          before: membership.roleKey,
          after: null,
          memberUserId: membership.userId,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      return membership.userId;
    });

    // `permissions.md` invariant 5, and carry-forward ruling 95 is the limit on
    // it: ONLY the sessions pointed at this organisation. A session of theirs
    // pointed at a different organisation, or at none, must survive — otherwise
    // a removed member holds a valid credential that no endpoint will answer,
    // including `POST /auth/logout`, which is the one that ends it.
    //
    // A SWITCH ALREADY IN FLIGHT CAN STILL MINT ONE, AND THIS `updateMany` IS
    // NOT WHAT STOPS IT. `Session.activeOrganizationId` is written by
    // `POST /auth/switch-org` and by nothing else, and sign-in creates sessions
    // with a null active organisation — but that endpoint reads the membership
    // and *then* calls `rotate`, which inserts a new row. This call is one
    // `updateMany` whose predicate is evaluated at execution time, so it cannot
    // revoke a row that does not exist yet.
    //
    // An earlier version of this comment argued from the switch endpoint's
    // `deletedAt: null` predicate that no such session could exist. It was
    // measured false — carry-forward ruling 82's shape exactly, which is the
    // ruling that struck the same reasoning down on the password-reset path:
    // writing the change before revoking is necessary and NOT sufficient.
    //
    // What closes it is on the other side, and it is ruling 82's remedy:
    // `OrganizationSwitchService` re-resolves the membership AFTER `rotate`
    // returns and revokes the session it has just issued when that read no
    // longer resolves. Either the insert precedes this revocation and is swept
    // by it, or it follows and the re-read observes this soft delete. There is
    // no third ordering — but the second half of that sentence lives in
    // `organization-switch.service.ts`, not here.
    await this.revokeSessions(removedUserId, ctx.organizationId);
  }
}

/**
 * The Prisma row, as `membershipResponseSchema` publishes it.
 *
 * Timestamps become ISO strings here rather than at the serialiser, for the
 * reason `organization.service.ts` gives: the wire contract says
 * `isoTimestampSchema`, and a `Date` reaching the serialiser would be formatted
 * to the same characters by accident rather than by decision.
 *
 * **Exported, and named `toMembershipResponse` rather than `toResponse`
 * because it now crosses a module boundary.** `InvitationService.accept`
 * returns the membership it created, and `acceptInvitationResponseSchema` is
 * `membershipResponseSchema` itself — so the two endpoints must serialise a
 * membership identically or one of them is lying about its schema.
 */
export function toMembershipResponse(row: {
  id: string;
  organizationId: string;
  // `MembershipStatus` (Prisma) and `MembershipStatus` (contracts) are the same
  // three values, and TypeScript accepts the Prisma row here with no assertion —
  // which is only true while they agree. `enum-parity.spec.ts` is what keeps
  // that so (carry-forward ruling 13); an `as` here would have hidden a
  // divergence instead of failing the build on it.
  status: MembershipResponse['status'];
  createdAt: Date;
  updatedAt: Date;
  role: { key: MembershipResponse['roleKey'] };
  user: { id: string; email: string; name: string | null };
}): MembershipResponse {
  return {
    id: row.id,
    organizationId: row.organizationId,
    user: { id: row.user.id, email: row.user.email, name: row.user.name },
    roleKey: row.role.key,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
