import { Inject, Injectable } from '@nestjs/common';
import {
  emailSchema,
  ERROR_CODES,
  LIST_LIMIT_MAX,
  type InvitationCollection,
  type InvitationResponse,
  type MembershipResponse,
  type SystemRole,
  type TenantContext,
} from '@sentinel/contracts';
import { newId, withTenantTransaction } from '@sentinel/db';
import { DomainError } from '../../common/errors/domain-error.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRequestContext } from '../auth/request-context.js';
import { hashSecretToken, mintSecretToken } from '../auth/secret-token.js';
import { TokenInvalidError } from '../auth/token-invalid.error.js';
import { TokenService } from '../auth/token.service.js';
import {
  assertActorMayGrant,
  lockOrganization,
  MEMBERSHIP_COLUMNS,
  toMembershipResponse,
} from '../memberships/membership.service.js';
import { encodeListCursor, type ListCursor } from '../organizations/list-cursor.js';
import { assertPathIsActiveTenant, notFound } from '../organizations/organization.service.js';
import type { InvitationOrganizationLookup } from './invitation-organization.store.js';
import {
  INVITATION_MAILER,
  INVITATION_ORGANIZATION_LOOKUP,
  type InvitationMailer,
} from './invitations.tokens.js';

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

export interface AcceptInvitationCommand extends AuthRequestContext {
  /**
   * The authenticated caller, from `request.principal` and from nowhere else.
   *
   * **D11 lives on this field.** The invited address is compared to *this*
   * user's address; there is no address in the body and
   * `acceptInvitationRequestSchema` has no field for one, by design — its own
   * docblock calls a body-supplied address "the whole attack".
   */
  readonly actorUserId: string;
  /** The raw token from the emailed link. Hashed here, never stored, never logged. */
  readonly token: string;
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
 * INVITATIONS: CREATE, LIST, REVOKE, ACCEPT.
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
 * **`accept` is the one exception, and only for its first statement.** The
 * person accepting is a member of nothing, so there is no id to open a
 * transaction with — the invitation row is what names it. That one lookup goes
 * through `INVITATION_ORGANIZATION_LOOKUP`, a `SECURITY DEFINER` function that
 * returns an organisation id and nothing else (ADR-0022,
 * `invitation-organization.store.ts`); everything the handler then decides
 * happens under RLS inside `withTenantTransaction(<that id>)`.
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
    @Inject(INVITATION_ORGANIZATION_LOOKUP)
    private readonly organizationOfInvitation: InvitationOrganizationLookup,
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
   * **An invitation that is already accepted, already revoked, or belongs to
   * another organisation all answer the same 404.** Cross-tenant is 404 and
   * never 403 (`security/authorization.md` §6 — a 403 confirms the resource
   * exists), and `notFound()` is imported rather than rebuilt so the three
   * cannot drift apart.
   *
   * **AN EXPIRED INVITATION IS A 204, NOT A 404, AND THAT IS THE DECISION.**
   * `LIVE_INVITATION` carries no `expiresAt` term — it cannot, for the reason
   * that constant records — so an expired-but-unconsumed row matches both
   * statements below, `revokedAt` is written, an `INVITATION_REVOKED` event is
   * recorded, and the caller gets 204. This docblock previously claimed the
   * opposite and the claim was false; the review measured 204 with a probe and
   * the ruling is that the code is right.
   *
   * Two reasons, and the first is the one that settles it:
   *
   * 1. **`list` applies no liveness filter.** `GET .../invitations` selects on
   *    `organizationId` and the cursor alone, so an expired invitation is in
   *    the list a holder of `organization.manage_members` can read. Telling
   *    that caller 404 when they ask to revoke a row they can see is two
   *    contradictory answers about one row.
   * 2. **The write has a real effect.** Setting `revokedAt` takes the row out
   *    of `Invitation_organizationId_email_live_key`'s live set and frees the
   *    `(organizationId, email)` slot immediately, rather than leaving it held
   *    until somebody re-invites. "There is nothing to revoke" was false.
   *
   * What the caller learns is that an expired invitation existed — which they
   * could already read in the list, holding the permission this route requires.
   * Pinned by the expiry case in `invitations.integration.spec.ts`.
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

  /**
   * `POST /api/v1/invitations/accept` — consume the token, become a member.
   *
   * # It is tenant-less, and the first statement is the one that finds a tenant
   *
   * D1: the acceptor is a member of nothing, so `TenantContextGuard` resolves
   * no organisation and there is no `TenantContext` to take. The organisation
   * is looked up from the token hash through `INVITATION_ORGANIZATION_LOOKUP`
   * — a `SECURITY DEFINER` function that returns one column and decides nothing
   * (ADR-0022). A `null` return is "no such invitation" and produces the same
   * `TokenInvalidError` every other refusal below produces.
   *
   * **Everything after that runs inside `withTenantTransaction`, under RLS.**
   * The invitation is re-read there by `tokenHash`, and liveness, expiry and
   * the address binding are decided on *that* row. Nothing the definer function
   * implied is trusted: it was asked which organisation, and it answered that
   * and no more.
   *
   * # ONE REFUSAL, AND THE ADDRESS IS CHECKED BEFORE THE STATE (D11)
   *
   * `TokenInvalidError` — 422 `TOKEN_INVALID` — for **every** unredeemable
   * token: unknown, expired, revoked, already accepted, superseded, and *not
   * yours*. `error-codes.ts` states the rule ("one code for four outcomes") and
   * `token-invalid.error.ts` names invitation acceptance as one of its callers.
   * A different signed-in user presenting somebody else's valid token gets
   * byte-identical bytes to one presenting a token that matches nothing, which
   * is the property D11 exists for and the one the plan calls "the interesting
   * attack, not the happy path".
   *
   * The address is compared **before** liveness and expiry are examined, so a
   * stranger holding a stolen link learns nothing about the invitation's state
   * either — not even whether it is still open. It costs one read to order it
   * this way, and the ordering is the difference between one refusal and an
   * oracle with one bit in it.
   *
   * **The address compared is the authenticated user's, read from `User` inside
   * the transaction, and never a body field.** `acceptInvitationRequestSchema`
   * carries the token alone: there is no field for an address to arrive in.
   * Both sides go through `emailSchema` before the comparison — the same
   * `.trim().toLowerCase()` normalisation both rows were written under — so a
   * casing difference cannot lock out the person the invitation was for.
   * `User` is not tenant-owned (`TENANT_OWNED_MODELS` is
   * `['Membership', 'Invitation', 'AuditEvent']`), carries no RLS policy, and
   * the tenant client passes the query through untouched.
   *
   * # The consume is conditional, and that is what makes two accepts one member
   *
   * D8. `updateMany` compiles to a single `UPDATE ... WHERE`, so the database
   * arbitrates: of two requests presenting one token, the first to acquire the
   * row's lock writes `acceptedAt` and reports `count: 1`, and the second
   * re-evaluates `acceptedAt IS NULL` against the committed row and reports
   * `count: 0`. A `SELECT` then an `UPDATE` passes every sequential test and
   * lets both through — two `Membership` rows for one invitation, of which the
   * partial unique index would refuse the second with a P2002 and a 500. The
   * expiry term is in the `WHERE` as well as in the branch above it, so the row
   * that is consumed is the row that was judged.
   *
   * `count !== 1` rather than `count === 0`: `updateMany` on a unique id cannot
   * affect two rows, and asserting the number the code believes rather than the
   * one it fears is what makes a future non-unique predicate fail loudly.
   *
   * # The organisation lock, and why acceptance is inside the set that takes it
   *
   * `lockOrganization` is imported from `membership.service.ts` rather than
   * written a second time — its docblock already named this method as its third
   * taker. Creating a `Membership` at `OWNER` changes the live owner count, so
   * acceptance is inside the window `product/permissions.md` invariant 1 is
   * about; a writer outside the serialisation reopens the race for the two
   * writers that are inside it.
   *
   * It is taken **before** the invitation is read, matching the order the two
   * membership writes use and for the same reason: a decision read before the
   * lock is a decision from the wrong snapshot.
   *
   * # D9 / RULING 122 — WHAT THIS TRANSACTION CLOSES, AND WHAT IT DOES NOT
   *
   * The rule: where a credential is issued against a fact that can change, the
   * fact must be re-read *after* the issue and the credential revoked if it
   * moved. "The endpoint checks first" is the argument rulings 82 and 122 both
   * struck down and it is not available here. Three facts, three answers:
   *
   * 1. **The invitation's liveness — CLOSED, and not by the check above.** The
   *    conditional `updateMany` here and `revoke`'s conditional `updateMany`
   *    write the same row under the same predicate, so Postgres serialises them
   *    at row level: whichever commits second re-evaluates
   *    `acceptedAt IS NULL AND revokedAt IS NULL` against the committed row and
   *    affects nothing. There is no interleaving in which both succeed, and
   *    none in which a membership stands for an invitation that was revoked
   *    first. Measured in `invitations.integration.spec.ts` with a
   *    session-level advisory-lock blocker rather than a `Promise.all`
   *    (ruling 119).
   * 2. **The organisation's state — NOT closed, cannot be, and survivable
   *    because a `Membership` is not a bearer credential.** Nothing in this API
   *    writes `Organization.status`, so a suspension is an operator statement
   *    and it can land one microsecond after any re-read this method could add
   *    — a re-read would move the window, not close it. What makes that
   *    survivable is that a `Membership` grants nothing on its own: there is no
   *    permission cache (carry-forward ruling 94), and `TenantContextGuard`
   *    re-resolves the membership *and* the organisation's status on every
   *    request that names an organisation, answering 403
   *    `ORGANIZATION_SUSPENDED`. Pinned by a test that suspends the
   *    organisation after a successful accept and finds the new member refused.
   *    This is the structural difference from ruling 82's `Session`, which *is*
   *    a bearer credential carrying a captured privilege for up to 30 days:
   *    acceptance mints no session and does not touch
   *    `Session.activeOrganizationId`. The acceptor must still call
   *    `POST /auth/switch-org`, which carries ruling 82's re-read after
   *    `rotate` in `organization-switch.service.ts`.
   * 3. **The inviter's authority — OPEN, and recorded rather than claimed
   *    closed.** D5's no-minting check runs in `create` and nowhere else, so an
   *    invitation offering `OWNER` survives its issuer being demoted or
   *    removed, and accepting it still mints an `OWNER`. Measured, and pinned
   *    by `records the OPEN D9 window` in `invitations.integration.spec.ts`.
   *    The remedy ruling 122 actually prescribes is on the *other* side — the
   *    moment the fact moves, which is `MembershipService.remove` and
   *    `updateRole`, where the invitations that member issued and could no
   *    longer issue would be revoked in the same transaction as the demotion.
   *    That is a change to Task 14's writes, not to this one, and it is handed
   *    up rather than taken here. Re-running `assertActorMayGrant` at this
   *    point instead would refuse every invitation from a colleague who has
   *    since legitimately left, which is a lock-out with no recovery path for
   *    the invitee.
   *
   * # No `@RequireVerifiedEmail()`, and no D5 check
   *
   * D2, recorded at the route. The role was authorised when the invitation was
   * issued; the acceptor is offered it rather than granting it, and holds no
   * permissions in this organisation to compare it against.
   */
  async accept(command: AcceptInvitationCommand): Promise<MembershipResponse> {
    // The raw token is hashed here and is not passed further. `hashSecretToken`
    // is the same function `create` used to write the column — one function, so
    // the two cannot drift into hashing differently.
    const tokenHash = hashSecretToken(command.token);

    // THE ONE STATEMENT OUTSIDE A TENANT TRANSACTION. See the class docblock
    // and `invitation-organization.store.ts`. It answers "which organisation",
    // which is the question no tenant context can be scoped to.
    const organizationId = await this.organizationOfInvitation.find(tokenHash);
    if (organizationId === null) throw new TokenInvalidError();

    return withTenantTransaction(this.base, organizationId, async (tx) => {
      await lockOrganization(tx, organizationId);

      // Re-read under RLS. `organizationId` is named as well as `tokenHash`
      // although `tokenHash` is unique and the policy would refuse a foreign
      // row anyway: three layers, all stated, for the reason
      // `membership.service.ts` gives. A row the definer function found but
      // this read cannot see would mean the id it returned did not match the
      // row it came from, and this branch refuses rather than proceeding.
      const invitation = await tx.invitation.findFirst({
        where: { tokenHash, organizationId },
        select: {
          id: true,
          email: true,
          roleId: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          role: { select: { key: true } },
        },
      });
      if (invitation === null) throw new TokenInvalidError();

      // D11, AND IT IS FIRST. The invited address against the AUTHENTICATED
      // user's, never against a body field — there is no address in the body
      // and the request schema has no field for one. `User` is not tenant-owned
      // and carries no policy, so this read is unaffected by the transaction's
      // organisation setting. A principal with no `User` row is unreachable —
      // `AuthenticationGuard` resolved the session from it — and is refused
      // rather than coalesced.
      const account = await tx.user.findUnique({
        where: { id: command.actorUserId },
        select: { email: true },
      });
      if (account === null) throw new TokenInvalidError();
      // Both sides through the shared normalisation. Both rows were written
      // under it already, so this is belt-and-braces against a row that
      // predates the schema or arrived by some other path — and it is the
      // comparison D11 names, so it is written where D11 is enforced rather
      // than assumed two files away.
      if (emailSchema.parse(account.email) !== emailSchema.parse(invitation.email)) {
        throw new TokenInvalidError();
      }

      // Liveness and expiry, decided here rather than by the definer function,
      // which deliberately filters on neither. `expiresAt` is compared against
      // one `now` that is also written as `acceptedAt` and used in the
      // conditional consume, so the three cannot disagree about when this
      // request happened.
      const now = new Date();
      if (invitation.acceptedAt !== null || invitation.revokedAt !== null) {
        throw new TokenInvalidError();
      }
      if (invitation.expiresAt.getTime() <= now.getTime()) throw new TokenInvalidError();

      // D7 / ruling 99, at its second call site. Reached only by the invited
      // person, so the 409 discloses their own membership to themselves. It is
      // a real branch rather than a formality: without it the partial unique
      // index `Membership_organizationId_userId_active_key` would
      // raise P2002 and the caller would see a 500 instead of a 409.
      await assertUserIsNotAlreadyAMember(tx, organizationId, command.actorUserId);

      // D8's conditional consume. The predicate repeats the three facts judged
      // above, so the row that is written is the row that was judged and no
      // interleaving can put a different one between them.
      const consumed = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          organizationId,
          ...LIVE_INVITATION,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now },
      });
      if (consumed.count !== 1) throw new TokenInvalidError();

      const membership = await tx.membership.create({
        data: {
          id: newId('mbr'),
          organizationId,
          userId: command.actorUserId,
          roleId: invitation.roleId,
          status: 'ACTIVE',
          // Carry-forward ruling 10: `status` and `deletedAt` are one fact,
          // held together by `Membership_status_deletedAt_agree_check`. Written
          // explicitly rather than defaulted, so a later `status: 'REMOVED'`
          // without its partner looks wrong at the call site rather than at the
          // database.
          deletedAt: null,
        },
        select: MEMBERSHIP_COLUMNS,
      });

      await this.audit.record(tx, {
        organizationId,
        actorType: 'USER',
        actorId: command.actorUserId,
        action: 'INVITATION_ACCEPTED',
        // The INVITATION, not the membership — `audit.actions.ts` records why:
        // this event is the end of the invitation's life, and a reader
        // following an invitation forwards needs its two events on one id.
        resourceType: 'Invitation',
        resourceId: invitation.id,
        // The three keys `audit.actions.ts` specifies, and `memberUserId`
        // matches what `ROLE_CHANGED` and `MEMBER_REMOVED` already use so one
        // reader can read all three. The raw token is not here and is not
        // reachable from this object (ruling 38).
        metadata: {
          membershipId: membership.id,
          roleKey: invitation.role.key,
          memberUserId: command.actorUserId,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      // `acceptInvitationResponseSchema` IS `membershipResponseSchema`, so the
      // serialiser is imported from `membership.service.ts` rather than written
      // again — two functions rendering one wire schema is how the two drift.
      return toMembershipResponse(membership);
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
 * The `User` lookup is unscoped on purpose. `User` is not a tenant-owned model
 * (`TENANT_OWNED_MODELS` is `['Membership', 'Invitation', 'AuditEvent']`), it
 * carries no `organizationId` and no RLS policy, and the tenant client passes
 * the query through untouched. An address with no account is not a member, which
 * is the common case for an invitation and is why this returns rather than
 * refusing.
 *
 * The predicate itself lives one function down, because `accept` asks the same
 * question of a user id it already holds.
 */
async function assertNotAlreadyAMember(
  tx: TenantTransaction,
  organizationId: string,
  email: string,
): Promise<void> {
  const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (user === null) return;
  await assertUserIsNotAlreadyAMember(tx, organizationId, user.id);
}

/**
 * THE PREDICATE ITSELF, WRITTEN ONCE FOR BOTH CALL SITES.
 *
 * `create` reaches it through the address, `accept` through the authenticated
 * user's own id. One function because it is one rule, and because the paragraph
 * below has to be true of both.
 *
 * # F-9 — `status: 'ACTIVE'` AND `deletedAt: null` ARE GUARDED AS A PAIR AND
 * NEITHER TERM ALONE CAN BE. DO NOT "SIMPLIFY" ONE AWAY.
 *
 * The CHECK constraint `Membership_status_deletedAt_agree_check` makes
 * `("deletedAt" IS NULL) = (status <> 'REMOVED')` a database invariant, so for
 * every row that can exist today the two terms are **equivalent by
 * construction**. That has a consequence a reader must be told rather than
 * discover: **no test can distinguish them.** The Task 15 reviewer measured it
 * on this exact function, three mutations against the invitations integration
 * file:
 *
 *     `deletedAt: null` removed, `status` kept   -> GREEN, 20/20, twice
 *     `status: 'ACTIVE'` removed, `deletedAt` kept -> GREEN, 20/20
 *     BOTH removed                                -> RED (the ruling 99/100 test)
 *
 * So a mutation deleting one term cannot go red, and a report claiming it did
 * is reporting something that did not happen. The guard is the pair, and the
 * test that holds it is `RULING 99/100 — re-invites a REMOVED member, with the
 * live rows arranged to lose` together with `F-9 — the ruling-99 predicate is
 * guarded as a PAIR`, which removes both.
 *
 * **What the second term buys, and the dependency that makes it matter.** The
 * two terms are equivalent *only while the CHECK holds*. Drop or relax that
 * constraint and they part company immediately: `INVITED` is neither `ACTIVE`
 * nor soft-deleted, and a row that is `INVITED` and live would be admitted by
 * `deletedAt: null` alone and refused by `status: 'ACTIVE'` alone — opposite
 * answers to "is this address already a member". Nothing writes
 * `MembershipStatus.INVITED` today (D10, and the controller's note on it), so
 * the day something does, the untested term becomes the live one. That is the
 * whole reason both stay, and it is why the comment names the constraint rather
 * than merely asserting redundancy.
 *
 * The same argument is written beside `assertOrganizationKeepsAnOwner`'s own
 * copy of the pair in `membership.service.ts`, which reached it first and by a
 * different route.
 */
async function assertUserIsNotAlreadyAMember(
  tx: TenantTransaction,
  organizationId: string,
  userId: string,
): Promise<void> {
  const membership = await tx.membership.findFirst({
    where: { organizationId, userId, status: 'ACTIVE', deletedAt: null },
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
