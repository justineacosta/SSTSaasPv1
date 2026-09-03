import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type SessionResponse, type TenantContext } from '@sentinel/contracts';
import { withTenantTransaction } from '@sentinel/db';
import type { Logger } from '@sentinel/observability';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  resolveTenant,
  type TenantResolution,
  type TenantResolver,
} from '../../common/guards/tenant-context.js';
import { LOGGER, PRISMA } from '../../infrastructure/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { TENANT_RESOLVER } from '../roles/roles.tokens.js';
import type { AuthRequestContext } from './request-context.js';
import { SessionDocumentService } from './session-document.service.js';
import { SessionService } from './session.service.js';

/**
 * The base Prisma client, named through the function that consumes it — the
 * same derivation `active-organization.store.ts` uses, and for the same reason:
 * `@sentinel/db/unscoped` is fenced by `no-restricted-imports` and the rule does
 * not distinguish a type-only import from a value one.
 */
export type TenantTransactionBase = Parameters<typeof withTenantTransaction>[0];

export interface SwitchOrganizationCommand extends AuthRequestContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string;
}

export interface SwitchedOrganization {
  readonly document: SessionResponse;
  /** The successor session's raw token, for the cookie. Returned exactly once. */
  readonly token: string;
  readonly cookieMaxAgeSeconds: number | null;
}

/**
 * The slice of `SessionService` this uses — the same narrow-port shape
 * `SessionRevoker` takes in `logout.service.ts`.
 *
 * `revoke` is here for one caller and one reason: the post-rotate membership
 * re-read below takes back a session it has just issued. Like
 * `login.service.ts`'s `SessionIssuer`, this is not a general capability handed
 * to this service, it is the second half of one check.
 */
export interface SessionRotator {
  rotate(input: {
    sessionId: string;
    status: 'ACTIVE';
    activeOrganizationId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{
    readonly session: { readonly id: string };
    readonly token: string;
    readonly cookieMaxAgeSeconds: number | null;
  } | null>;
  revoke(sessionId: string): Promise<boolean>;
}

/**
 * The one method of `SessionDocumentService` this service calls.
 *
 * A narrow port for the same reason `SessionRotator` is one, plus a second that
 * is specific to it: `SessionDocumentService` holds private collaborators, so a
 * spec cannot stand in for it without a type assertion. Declared as an
 * interface here, injected as the class in the constructor — the pattern this
 * file already uses for `SessionService`.
 */
export interface SessionDocumentBuilder {
  forPrincipal(
    principal: { userId: string; sessionId: string },
    tenant: TenantContext | undefined,
  ): Promise<SessionResponse>;
}

/**
 * The refusal for an unresolved tenant, built once and thrown from **both**
 * membership reads.
 *
 * One function rather than two copies, for the reason `tenant-context.ts` gives
 * about its own pair: two constructors with the same arguments is how two
 * responses drift apart in a later edit. It matters more here than usual — the
 * second caller is the post-rotate re-read, and a caller who could tell the two
 * refusals apart would learn from the difference that their membership was live
 * when the request started.
 *
 * `not-a-member` and `no-active-organization` are 404 `RESOURCE_NOT_FOUND`,
 * byte-identical, because `api/authorization.md` §3 maps them onto one row: a
 * 403 would confirm the organisation exists. `organization-suspended` is 403
 * with the code, status and message `TenantContextGuard` gives, because the
 * caller *is* a member and the suspension is not somebody else's secret.
 */
function refusalFor(outcome: Exclude<TenantResolution['outcome'], 'resolved'>): DomainError {
  if (outcome === 'organization-suspended') {
    return new DomainError(
      ERROR_CODES.ORGANIZATION_SUSPENDED,
      'This organisation is suspended. Contact your organisation owner or Sentinel support to restore access.',
      403,
    );
  }
  return new DomainError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Not found.', 404);
}

/**
 * `POST /api/v1/auth/switch-org` — THE TASK THAT MAKES TASK 12 REAL.
 *
 * `Session.activeOrganizationId` is the only source of the active organisation
 * and **nothing in this codebase wrote it until this file** (carry-forward
 * ruling 93). Every layer Task 12 built — tenant resolution, the
 * organisation-status check, the MFA-enrolment gate, the permission check —
 * short-circuits while that column is NULL. This is the write that starts them.
 *
 * # Membership is decided by the guard's own function, not by a second opinion
 *
 * It calls `TENANT_RESOLVER` and hands the answer to `resolveTenant`, which is
 * the pure function `TenantContextGuard` uses. That is deliberate and it is the
 * property worth having: **a switch succeeds exactly when the guard would
 * resolve on the next request.** A second membership query written here would
 * eventually disagree with the one that decides authorization, and the failure
 * would be a caller who switched successfully into an organisation every
 * guarded route then answers 404 for.
 *
 * It also means the `deletedAt: null` predicate of carry-forward ruling 99 is
 * inherited rather than re-derived: `(organizationId, userId)` is unique only
 * where `deletedAt IS NULL`, so a re-added member has several rows and an
 * unordered read may return a `REMOVED` one.
 *
 * # Not a member is 404. Suspended is 403.
 *
 * `no-active-organization` and `not-a-member` both answer 404
 * `RESOURCE_NOT_FOUND`, byte-identical, because `api/authorization.md` §3 maps
 * "not a member of the target organisation" and "resource belongs to another
 * tenant" onto one row — a 403 would confirm the organisation exists. An
 * organisation id that has never existed and one belonging to somebody else are
 * therefore indistinguishable here, which is the point.
 *
 * `organization-suspended` answers **403 `ORGANIZATION_SUSPENDED`**, with the
 * same code, status and message `TenantContextGuard` gives. The caller is a
 * member, so the suspension is not somebody else's secret, and the two refusals
 * agreeing is what stops a member from switching into an organisation where
 * every subsequent guarded request would refuse them with a different answer
 * than the one they got here. A member is never stranded by it: `switch-org` is
 * `@AuthenticatedOnly()`, so they can always switch to a different
 * organisation, read their session and sign out.
 *
 * # The session is rotated, and that is `authentication.md` §3's rule
 *
 * "Rotate on privilege change." Switching organisation changes the effective
 * permission set of the credential in the browser, so the token that existed
 * before the change cannot be used after it — which is what stops an attacker
 * who planted a session value from riding the victim's escalation. The
 * predecessor is revoked and its cache entry tombstoned by `SessionService`
 * before the successor row is written.
 *
 * `rotate` returning `null` means there was nothing live to rotate — a
 * concurrent logout or rotation won the race. That is answered 401
 * `SESSION_EXPIRED` rather than 500: the caller's credential really is gone,
 * and telling them to sign in again is the accurate instruction.
 *
 * # The audit row is written AFTER the rotation, and that is a compromise
 *
 * `CLAUDE.md` rule 10 wants the event and the change in one transaction.
 * `SessionService.rotate` takes no transaction handle — deliberately, because
 * it owns an ordering that spans Redis and Postgres — so one transaction over
 * both is not expressible without reopening Task 6. `logout.service.ts` faced
 * exactly this and chose **act, then audit**, for a reason that applies
 * unchanged here: auditing first would leave an append-only row asserting a
 * switch that did not happen, and this codebase treats a false statement in a
 * table that cannot be corrected as worse than a gap in the trail. Neither
 * error is swallowed — a switch that could not be audited is a 500, not a quiet
 * 200.
 *
 * The row lands in the organisation being switched **to**, inside a tenant
 * transaction on it. `AuditEvent` carries RLS keyed on `organizationId` and the
 * API connects as `sentinel_app`, so a write outside that transaction is
 * refused by the policy rather than merely mis-scoped.
 *
 * # THE MEMBERSHIP IS READ TWICE, AND THE SECOND READ IS THE CONTROL
 *
 * Carry-forward ruling 82, and it is `login.service.ts`'s
 * `credentialStillCurrent` applied to membership instead of to a password hash.
 *
 * `rotate` **inserts a new `Session` row**. A member removal running
 * concurrently revokes sessions with one `updateMany`, whose predicate is
 * evaluated at execution time — so it cannot revoke a row that does not exist
 * yet. A switch whose membership read preceded the removal's commit and whose
 * insert follows the removal's revocation was therefore never swept. Measured
 * on this file, with a 2 s delay instrumented between the read and `rotate`:
 * the switch answered **200** with a populated permission set and left a live,
 * `ACTIVE`, un-revoked session pointed at the organisation the member had just
 * been removed from, which `GET /auth/session` then answered **200** for with
 * that organisation's `id`, `slug` and `name`.
 *
 * Writing the membership change before revoking is necessary and **not
 * sufficient** — that is the exact overstatement ruling 82 corrected on the
 * login path, and `session.service.ts` names this route as the next one to carry
 * the equivalent. What makes the promise true is a re-read *after* the
 * credential is issued: either the insert precedes the revocation and is swept
 * by it, or it follows and this read observes the removal. There is no third
 * ordering.
 *
 * It re-resolves through the **same** `TENANT_RESOLVER` and `resolveTenant` the
 * first read uses, so the property this file is built on — a switch succeeds
 * exactly when the guard would resolve on the next request — is re-asserted
 * rather than approximated by a second query. The refusal is built by the same
 * function as the first one, so a caller cannot tell the two apart, and the
 * session just issued is revoked before it is thrown.
 *
 * **The caller is signed out entirely when this fires, and that is stated
 * rather than hidden.** `rotate` has already revoked the predecessor, so a
 * refusal here leaves the caller with no live session and a dead cookie; they
 * sign in again. It is a stricter end state than the removal's own revocation
 * would have produced — that one spares a session pointed elsewhere — and it is
 * the safe direction. Ruling 95 is not violated: the account is untouched and
 * signing in works.
 *
 * **What this does not claim.** The window is not closed by being made small,
 * it is closed by the re-read. And the blast radius was bounded in the other
 * direction already: `TenantContextGuard` re-reads membership on every request
 * with no cache (ruling 94), so every *guarded* route answered 404 for that
 * session throughout. What this stops is the session existing at all, and
 * `GET /auth/session` disclosing the organisation's name to somebody who is no
 * longer in it.
 */
@Injectable()
export class OrganizationSwitchService {
  constructor(
    @Inject(TENANT_RESOLVER) private readonly resolve: TenantResolver,
    @Inject(SessionService) private readonly sessions: SessionRotator,
    @Inject(SessionDocumentService) private readonly sessionDocument: SessionDocumentBuilder,
    @Inject(PRISMA) private readonly base: TenantTransactionBase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async switch(command: SwitchOrganizationCommand): Promise<SwitchedOrganization> {
    const resolution = resolveTenant({
      activeOrganizationId: command.organizationId,
      ...(await this.resolve({
        userId: command.userId,
        organizationId: command.organizationId,
      })),
    });

    if (resolution.outcome !== 'resolved') throw refusalFor(resolution.outcome);

    const rotated = await this.sessions.rotate({
      sessionId: command.sessionId,
      // `ACTIVE`, explicitly. `rotate` has no default for status on purpose —
      // `session.service.ts` says there is no correct value a schema could pick
      // on a caller's behalf — and a `PENDING_MFA` session cannot reach this
      // route at all, because `AuthenticationGuard` refuses one on every
      // handler that does not carry `@AllowPendingMfa()`.
      status: 'ACTIVE',
      activeOrganizationId: command.organizationId,
      ip: command.ip,
      userAgent: command.userAgent,
    });
    if (rotated === null) {
      throw new DomainError(
        ERROR_CODES.SESSION_EXPIRED,
        'That session is no longer active. Sign in again.',
        401,
      );
    }

    // RULING 82. THE SESSION NOW EXISTS; CHECK THAT THE MEMBERSHIP IT RESTS ON
    // STILL DOES. Before the audit row, so a switch that is taken back does not
    // leave an append-only event saying it happened.
    const stillAMember = resolveTenant({
      activeOrganizationId: command.organizationId,
      ...(await this.resolve({
        userId: command.userId,
        organizationId: command.organizationId,
      })),
    });
    if (stillAMember.outcome !== 'resolved') {
      await this.sessions.revoke(rotated.session.id);
      // The user id, the organisation and the session id, and nothing else. A
      // session id is an identifier; the token is the secret and it appears
      // nowhere here (critical security rule 6). An operator needs the fact
      // that a session was taken back, because the response the caller sees is
      // the ordinary refusal and says nothing about it.
      this.logger.warn(
        {
          userId: command.userId,
          organizationId: command.organizationId,
          sessionId: rotated.session.id,
          outcome: stillAMember.outcome,
        },
        'membership changed while this organisation switch was in flight; the session it issued was revoked',
      );
      throw refusalFor(stillAMember.outcome);
    }

    await withTenantTransaction(this.base, command.organizationId, (tx) =>
      this.audit.record(tx, {
        organizationId: command.organizationId,
        // The actor really is the user: they presented a live session cookie
        // and the CSRF token derived from it, and they have just been proved an
        // ACTIVE member of this organisation.
        actorType: 'USER',
        actorId: command.userId,
        action: 'ORGANIZATION_SWITCHED',
        // The organisation, not the session. The subject of the event is the
        // organisation the member began acting in — which is also the tenant
        // whose audit log this row lands in, so a reader asking "who started
        // acting here" finds it under the resource they are looking at.
        resourceType: 'Organization',
        resourceId: command.organizationId,
        // The successor session, so an investigation can join this event to
        // everything that session then did. A session ID is an identifier, not
        // a credential — the token is the secret and it appears nowhere here.
        // `roleKey` records what the member switched in AS, which is the fact a
        // later role change makes impossible to reconstruct from current state.
        metadata: { sessionId: rotated.session.id, roleKey: stillAMember.context.roleKey },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      }),
    );

    return {
      // THE SAME BUILDER `GET /auth/session` USES, given the tenant context the
      // resolver just produced. One shape, so a client can reuse one parser and
      // one piece of state — `switchOrganizationResponseSchema` IS
      // `sessionResponseSchema`, and building this document by hand here is how
      // the two would drift.
      //
      // The successor's id, not the predecessor's: the document reports the
      // session the caller now holds, and the predecessor was revoked a few
      // lines up.
      document: await this.sessionDocument.forPrincipal(
        { userId: command.userId, sessionId: rotated.session.id },
        // The RE-READ's context, not the first read's. Both are resolutions of
        // the same membership and the second is the fresher of the two, so the
        // document and the audit row report the role the member holds now
        // rather than the one they held when the request started.
        stillAMember.context,
      ),
      token: rotated.token,
      cookieMaxAgeSeconds: rotated.cookieMaxAgeSeconds,
    };
  }
}
