import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  LIST_LIMIT_MAX,
  type InvitationCollection,
  type InvitationResponse,
  type SystemRole,
  type TenantContext,
} from '@sentinel/contracts';
import { newId, withTenantTransaction } from '@sentinel/db';
import { DomainError } from '../../common/errors/domain-error.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRequestContext } from '../auth/request-context.js';
import { mintSecretToken } from '../auth/secret-token.js';
import { TokenService } from '../auth/token.service.js';
import { assertActorMayGrant } from '../memberships/membership.service.js';
import { encodeListCursor, type ListCursor } from '../organizations/list-cursor.js';
import { assertPathIsActiveTenant, notFound } from '../organizations/organization.service.js';
import { INVITATION_MAILER, type InvitationMailer } from './invitations.tokens.js';

/**
 * The base Prisma client, named through the function that consumes it.
 *
 * `Parameters<typeof withTenantTransaction>[0]` rather than a type import of
 * `PrismaClient`: `@sentinel/db/unscoped` is fenced by `no-restricted-imports`
 * and the rule does not distinguish a type-only import from a value one. The
 * same derivation `membership.service.ts` uses, for the same reason.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

/** The transaction handle `withTenantTransaction` yields. */
type TenantTransaction = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

export interface ListInvitationsCommand {
  readonly limit: number;
  readonly cursor: ListCursor | null;
}

export interface CreateInvitationCommand extends AuthRequestContext {
  readonly actorUserId: string;
  /** Already normalised by `emailSchema` — trimmed and lower-cased. */
  readonly email: string;
  readonly roleKey: SystemRole;
}

export interface RevokeInvitationCommand extends AuthRequestContext {
  readonly actorUserId: string;
}

/**
 * THE COLUMNS `invitationResponseSchema` PUBLISHES, AND NO OTHERS.
 *
 * **`tokenHash` is absent, and its absence is the control.** The contract's own
 * docblock says why: only a hash is stored and the raw token reaches the invited
 * address once, so a list endpoint that echoed either would hand everyone who
 * can read the organisation's invitations something they should not have. The
 * schema strips an unknown key on the way out (response schemas are not
 * `.strict()`), which `packages/contracts/src/invitations.spec.ts` pins — this
 * `select` is the other half, and it is the half that stops the value being
 * read out of the database at all.
 *
 * Written once and shared by the three statements that return an invitation,
 * for the reason `MEMBERSHIP_COLUMNS` gives: a column added to the response then
 * has one place to be added rather than three.
 */
const INVITATION_COLUMNS = {
  id: true,
  organizationId: true,
  email: true,
  invitedByUserId: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  role: { select: { key: true } },
} as const;

/**
 * The refusal for "this address is already a live member of this organisation".
 *
 * 409, per `api/conventions.md` §2's status table — "Conflict: duplicate, or
 * version mismatch". The body parsed, the caller holds the permission, the
 * address is well formed, and the request conflicts with the organisation's
 * current state. 422 is for a domain rule about a *transition*; this is a
 * duplicate, which the table gives its own row and `api/errors.md` its own code.
 *
 * It names the state rather than the person: an actor holding
 * `organization.manage_members` may already list every member, so telling them
 * that this address is one of them discloses nothing they cannot read.
 */
function alreadyAMember(): DomainError {
  return new DomainError(
    ERROR_CODES.DUPLICATE_RESOURCE,
    'That address is already a member of this organisation.',
    409,
  );
}

/**
 * D4 — THE ADVISORY LOCK, AND WHY SUPERSEDE-THEN-INSERT IS UNSOUND WITHOUT ONE.
 *
 * Carry-forward ruling 31, and this is the "any later task writing a
 * supersede-then-insert pair against a non-unique index needs the same thing"
 * that ruling names. `TokenService.issue` holds
 * `pg_advisory_xact_lock(hashtext('vtk:<userId>:<purpose>'))` as the first
 * statement in its transaction, and the reason is measured rather than argued:
 * under Postgres's default READ COMMITTED a second transaction's
 * `UPDATE ... WHERE "revokedAt" IS NULL` cannot see the first transaction's
 * uncommitted `INSERT`, so it supersedes nothing and both rows commit live.
 * Task 4 measured that at ten live pairs out of ten before the lock existed.
 *
 * Here the database is a second line rather than the only one: since
 * `20260903160000_invitation_partial_unique`,
 * `Invitation_organizationId_email_live_key` is UNIQUE
 * `("organizationId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS
 * NULL`. So two concurrent creates without this lock do not produce two live
 * invitations — the second raises P2002 and the caller sees a 500. The lock is
 * what turns that into two serialised requests, the second superseding the
 * first, which is the behaviour `security/authentication.md` §6 describes.
 *
 * **The key is the pair the invariant is about**, exactly as `TokenService`'s
 * is: `inv:<organizationId>:<email>`, so two invitations to different addresses
 * in one organisation do not queue behind each other. `hashtext` collisions are
 * possible and harmless — the cost of one is that two unrelated pairs serialise
 * for the few milliseconds this transaction lasts.
 *
 * The lock call sits in a subquery so the result set is a plain `int`:
 * `pg_advisory_xact_lock` returns `void` and `$queryRaw` fails to deserialise
 * that — a Prisma error raised AFTER the lock has been taken, so it would abort
 * the transaction while looking like a SQL mistake. Same shape, same reason, as
 * `TokenService.issueInTransaction`.
 *
 * It is parameterised by the tagged template, not interpolated into SQL.
 */
async function lockInvitationSlot(
  tx: TenantTransaction,
  organizationId: string,
  email: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`inv:${organizationId}:${email}`}))) AS lock_taken`;
}

/**
 * INVITATIONS: CREATE, LIST, REVOKE.
 *
 * `POST /api/v1/invitations/accept` is **not here**, and its absence is
 * measured rather than deferred. See `invitations.controller.ts`.
 *
 * # Every write is one transaction and the audit row is inside it
 *
 * `CLAUDE.md` rule 10 and `security/audit.md` §2, the same discipline
 * `MembershipService` follows: if the change rolls back so does the event.
 * `AuditService.record` takes the transaction handle instead of opening one, so
 * there is no way to write an event for a change that then failed.
 *
 * # It holds the base client and every statement is wrapped
 *
 * `PRISMA` is the *unscoped* client, connecting as `sentinel_app`. `Invitation`
 * carries `FORCE ROW LEVEL SECURITY` with
 * `USING ("organizationId" = current_setting('app.organization_id', true))`, so
 * a bare read on this client returns zero rows. Measured against the compose
 * Postgres as `sentinel_app` on 2026-09-04: a `SELECT count(*) FROM
 * "Invitation" WHERE "tokenHash" = '<known hash>'` returned **0** with no
 * setting, **1** with the owning organisation set, and **0** with a different
 * organisation set. Every method below runs inside `withTenantTransaction`.
 *
 * # Mail is sent after the transaction commits
 *
 * Carry-forward ruling 44, and `AuthMailer`'s own docblock. A send inside the
 * transaction either holds it open across network I/O to a third party or tells
 * somebody they have been invited to an organisation by a write that then
 * rolled back — and an email cannot be recalled while a transaction can. The
 * mailer port is called after `withTenantTransaction` returns, and it swallows
 * a failure (ruling 45): a lost invitation is remedied by inviting again, which
 * supersedes rather than duplicating.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(PRISMA) private readonly base: TenantTransactionBase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(INVITATION_MAILER) private readonly sendInvitation: InvitationMailer,
  ) {}

  /**
   * `POST /api/v1/organizations/:id/invitations`.
   *
   * The order of the refusals is deliberate and is the order a caller learns
   * the least from:
   *
   * 1. the path id against the resolved tenant (404 — the caller learns nothing
   *    about whether the organisation exists);
   * 2. D5's no-minting check (403 — about the caller's own authority, which
   *    they already know);
   * 3. the already-a-member check (409 — about the organisation's roster, which
   *    a holder of `organization.manage_members` may already read).
   *
   * **D5 is checked before the transaction opens**, unlike `MembershipService`'s
   * two writes, which check it inside their organisation lock. The difference is
   * that the role's permissions are seeded reference data with no RLS and
   * nothing in this transaction can change them, so reading them outside buys a
   * refusal that costs no lock. `assertActorMayGrant` is imported rather than
   * re-implemented — see D5 below.
   */
  async create(
    ctx: TenantContext,
    pathId: string,
    command: CreateInvitationCommand,
  ): Promise<InvitationResponse> {
    assertPathIsActiveTenant(ctx, pathId);

    const created = await withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
      // D5 — YOU CANNOT INVITE SOMEBODY INTO A ROLE WHOSE PERMISSIONS YOU DO NOT
      // HOLD. `security/authorization.md` §4's no-minting rule, at its third
      // call site: an `ADMIN` may not invite an `OWNER` for the same reason
      // they may not promote one, and carry-forward ruling 124 is why the
      // symmetry matters — a rule enforced on one verb and not its inverse is
      // not an authority model. The function is imported from
      // `membership.service.ts` rather than copied; see this file's import
      // list and the module docblock for the cycle measurement.
      //
      // Read from the seeded `RolePermission` rows rather than from
      // `ROLE_PERMISSIONS` in `@sentinel/contracts`, so both sides of the
      // comparison have the same origin as `ctx.permissions`. `Role` is
      // deliberately-global reference data with no RLS;
      // `findUniqueOrThrow` rather than `findUnique` because `roleKey` has
      // already been parsed against `systemRoleSchema`, so a missing row is an
      // unseeded database — a deployment fault, not a client error.
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

      await lockInvitationSlot(tx, ctx.organizationId, command.email);

      await assertNotAlreadyAMember(tx, ctx.organizationId, command.email);

      // D4, FIRST HALF: revoke whatever is live for this pair, and capture its
      // id before doing so.
      //
      // Read then write, in that order, because the audit row names the
      // superseded invitation and `updateMany` returns only a count. The read
      // is safe here and would not be outside the lock: nothing else can insert
      // a live row for this pair while this transaction holds it, and the
      // partial unique index guarantees the read returns at most one.
      //
      // **EXPIRY IS NOT IN THE PREDICATE, AND THAT IS THE POINT.** The index's
      // predicate cannot mention `expiresAt` — a partial index predicate must
      // be IMMUTABLE and `"expiresAt" > now()` is not — so an
      // expired-but-unconsumed row still holds the slot. This `updateMany` is
      // what frees it, which is why re-inviting an address whose invitation
      // expired succeeds rather than colliding.
      const superseded = await tx.invitation.findFirst({
        where: { organizationId: ctx.organizationId, email: command.email, ...LIVE_INVITATION },
        select: { id: true },
      });
      const supersededAt = new Date();
      if (superseded !== null) {
        await tx.invitation.updateMany({
          where: { organizationId: ctx.organizationId, email: command.email, ...LIVE_INVITATION },
          // `revokedAt`, not a third column. §6 treats "used" and "replaced by a
          // newer invitation" as two outcomes with one meaning — the link in
          // that email no longer works — and the row has exactly one column for
          // each. The forensic difference is in the audit trail:
          // `MEMBER_INVITED` carries `supersededInvitationId`, and
          // `INVITATION_REVOKED` is absent, so a reader can tell a supersession
          // from a revocation without a column for it. See `audit.actions.ts`.
          data: { revokedAt: supersededAt },
        });
      }

      // D4, SECOND HALF. The order is not interchangeable: inserting first and
      // superseding second would match the row just written — `revokedAt IS
      // NULL` is true of it — and revoke the new invitation at birth. The same
      // trap `TokenService.issueInTransaction` records.
      const minted = mintSecretToken();
      const invitation = await tx.invitation.create({
        data: {
          id: newId('inv'),
          organizationId: ctx.organizationId,
          email: command.email,
          roleId: granted.id,
          tokenHash: minted.tokenHash,
          invitedByUserId: command.actorUserId,
          // §6's 7-day TTL, read from the same configuration
          // `TokenService.ttlSecondsFor('INVITATION')` reports to the email
          // body — so an operator who shortens it during an incident does not
          // leave the message claiming the old one.
          expiresAt: this.tokens.expiresAtFor('INVITATION'),
        },
        select: INVITATION_COLUMNS,
      });

      await this.audit.record(tx, {
        organizationId: ctx.organizationId,
        actorType: 'USER',
        actorId: command.actorUserId,
        action: 'MEMBER_INVITED',
        resourceType: 'Invitation',
        resourceId: invitation.id,
        // THE RAW TOKEN IS NOT HERE, AND `minted.token` IS NOT REACHABLE FROM
        // THIS OBJECT. Carry-forward ruling 38: the audit event is the
        // endpoint's to write and the raw token never enters one. What is here
        // is the address, the role and the supersession — see
        // `audit.actions.ts` for why each earns its place.
        metadata: {
          email: command.email,
          roleKey: command.roleKey,
          supersededInvitationId: superseded?.id ?? null,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      // The organisation's own name, for the message. Read inside the
      // transaction and keyed on the resolved tenant, so a rename between the
      // guard and this statement cannot make the invitation name one
      // organisation and the email another.
      const organization = await tx.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { name: true },
      });
      if (organization === null) throw notFound();

      return { row: invitation, token: minted.token, organizationName: organization.name };
    });

    // AFTER THE COMMIT, NEVER INSIDE IT. Ruling 44. The port takes no
    // transaction handle, which makes calling it from inside one awkward to
    // write rather than easy to do by mistake.
    await this.sendInvitation({
      to: created.row.email,
      token: created.token,
      organizationName: created.organizationName,
    });

    return toResponse(created.row);
  }

  /**
   * `GET /api/v1/organizations/:id/invitations` — every invitation this
   * organisation has issued, newest first.
   *
   * **Every one, not only the live ones, and that is a decision.** The three
   * alternatives were: live only, live-and-unexpired only, or all. All, because
   * `invitationResponseSchema` publishes `acceptedAt` and `revokedAt` as
   * nullable columns, which is only meaningful if consumed rows can appear;
   * because an administrative list gated on `organization.manage_members` is
   * the natural place to answer "did we ever invite this person"; and because
   * adding a status filter later is additive to `listInvitationsQuerySchema`
   * while removing rows from a shipped list is a breaking change. A client
   * rendering "pending invitations" filters on `acceptedAt === null &&
   * revokedAt === null && expiresAt > now`.
   *
   * The clamp and the echo are one feature, exactly as on the memberships list:
   * `listQuerySchema` clamps a limit above `LIST_LIMIT_MAX` rather than
   * rejecting it, and `pagination.limit` reports the limit that was applied.
   *
   * Keyset pagination on `(createdAt, id)` descending. The id tie-breaker is not
   * optional (`api/pagination.md` §1): invitations written by one transaction
   * share a timestamp, so ordering on `createdAt` alone silently skips or
   * repeats rows. The cursor's `createdAt` reaches Postgres as a `Date` this
   * process constructed, not as the client's string — carry-forward ruling 111.
   */
  async list(
    ctx: TenantContext,
    pathId: string,
    command: ListInvitationsCommand,
  ): Promise<InvitationCollection> {
    assertPathIsActiveTenant(ctx, pathId);

    const limit = Math.min(command.limit, LIST_LIMIT_MAX);
    const cursor = command.cursor;
    const rows = await withTenantTransaction(this.base, ctx.organizationId, (tx) =>
      tx.invitation.findMany({
        where: {
          organizationId: ctx.organizationId,
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
        select: INVITATION_COLUMNS,
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toResponse),
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
   * `DELETE /api/v1/organizations/:id/invitations/:invitationId`.
   *
   * **The conditional write is the decision.** `updateMany` compiles to a single
   * `UPDATE ... WHERE`, so the database arbitrates: of two requests revoking one
   * invitation at the same instant, the first to acquire the row's lock writes
   * `revokedAt` and reports `count: 1`, and the second re-evaluates
   * `revokedAt IS NULL` against the committed row and reports `count: 0`. A
   * `SELECT` followed by an `UPDATE` passes every sequential test and lets both
   * succeed, which here would mean two `INVITATION_REVOKED` events for one
   * revocation. The same shape `TokenService.consume` uses and for the same
   * reason.
   *
   * **An invitation that is already accepted, already revoked, expired, or
   * belongs to another organisation all answer the same 404.** Cross-tenant is
   * 404 and never 403 (`security/authorization.md` §6 — a 403 confirms the
   * resource exists), and `notFound()` is imported rather than rebuilt so the
   * three cannot drift apart. An expired invitation answering 404 rather than a
   * successful revocation is deliberate: there is nothing to revoke, and a 204
   * would tell the caller they had changed something they had not.
   *
   * 204 with no body, per `api/conventions.md` §2.
   */
  async revoke(
    ctx: TenantContext,
    pathId: string,
    invitationId: string,
    command: RevokeInvitationCommand,
  ): Promise<void> {
    assertPathIsActiveTenant(ctx, pathId);

    await withTenantTransaction(this.base, ctx.organizationId, async (tx) => {
      // Read first, for the audit metadata, and the read decides nothing — the
      // conditional write below is what decides. `organizationId` is named
      // explicitly although the tenant-scoping extension would inject it and
      // RLS would refuse the row anyway: three layers, all stated, for the
      // reason `membership.service.ts` gives.
      const invitation = await tx.invitation.findFirst({
        where: { id: invitationId, organizationId: ctx.organizationId, ...LIVE_INVITATION },
        select: { id: true, email: true, role: { select: { key: true } } },
      });
      if (invitation === null) throw notFound();

      const written = await tx.invitation.updateMany({
        where: { id: invitationId, organizationId: ctx.organizationId, ...LIVE_INVITATION },
        data: { revokedAt: new Date() },
      });
      if (written.count === 0) throw notFound();

      await this.audit.record(tx, {
        organizationId: ctx.organizationId,
        actorType: 'USER',
        actorId: command.actorUserId,
        action: 'INVITATION_REVOKED',
        resourceType: 'Invitation',
        resourceId: invitationId,
        metadata: { email: invitation.email, roleKey: invitation.role.key },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });
  }
}

/**
 * "Live" for an invitation: neither accepted nor revoked.
 *
 * **It matches the partial unique index's predicate exactly**, and that is the
 * whole reason it is a shared constant rather than three inline object
 * literals. `Invitation_organizationId_email_live_key` is
 * `WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`; a query that used a
 * different definition of live would disagree with the constraint that enforces
 * uniqueness over it, and the disagreement would show up as a P2002 on a path
 * that had just checked there was nothing to collide with.
 *
 * **Expiry is deliberately not part of it**, for the same reason it is not part
 * of the index: a predicate mentioning `now()` is not IMMUTABLE and Postgres
 * refuses it. An expired row is still "live" by this definition and still holds
 * the slot, and `create`'s supersession is what frees it.
 */
const LIVE_INVITATION = { acceptedAt: null, revokedAt: null } as const;

/**
 * D7 / RULING 99 — "IS THIS ADDRESS ALREADY A MEMBER?" EXCLUDES THE
 * SOFT-DELETED, AND SAYS SO.
 *
 * `(organizationId, userId)` is unique on `Membership` only
 * `WHERE "deletedAt" IS NULL`, so a member who has been removed and re-added
 * has several rows for one pair and only one of them is live. Without
 * `deletedAt: null` this read can return a `REMOVED` row —
 * non-deterministically, because a small table is seq-scanned in physical order
 * — and the endpoint would then refuse to re-invite somebody who genuinely
 * left, which is the exact case Task 1's partial index and this task exist to
 * unblock.
 *
 * Ruling 100 binds the test that guards it: the fixture removes and *then*
 * re-adds, so the live row is physically last and a resolver without the
 * predicate returns the removed one. A test arranged the other way passes under
 * the mutation.
 *
 * `status: 'ACTIVE'` as well as `deletedAt: null`, on the reasoning
 * `assertOrganizationKeepsAnOwner` records for its own pair: the CHECK
 * constraint ties `REMOVED` to soft-deleted, but `INVITED` is neither. Nothing
 * writes `MembershipStatus.INVITED` today — see the controller's D10 note — so
 * the two predicates cannot currently disagree, and the day something does, an
 * invitation is not a membership and must not block a second one.
 *
 * The `User` lookup is unscoped on purpose. `User` is not a tenant-owned model
 * (`TENANT_OWNED_MODELS` is `['Membership', 'Invitation', 'AuditEvent']`), it
 * carries no `organizationId` and no RLS policy, and the tenant client passes
 * the query through untouched. An address with no account is not a member, which
 * is the common case for an invitation and is why this returns rather than
 * refusing.
 */
async function assertNotAlreadyAMember(
  tx: TenantTransaction,
  organizationId: string,
  email: string,
): Promise<void> {
  const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (user === null) return;

  const membership = await tx.membership.findFirst({
    where: { organizationId, userId: user.id, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (membership !== null) throw alreadyAMember();
}

/**
 * The Prisma row, as `invitationResponseSchema` publishes it.
 *
 * Timestamps become ISO strings here rather than at the serialiser, for the
 * reason `organization.service.ts` gives: the wire contract says
 * `isoTimestampSchema`, and a `Date` reaching the serialiser would be formatted
 * to the same characters by accident rather than by decision.
 */
function toResponse(row: {
  id: string;
  organizationId: string;
  email: string;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  role: { key: InvitationResponse['roleKey'] };
}): InvitationResponse {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    roleKey: row.role.key,
    invitedByUserId: row.invitedByUserId,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
