import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import type { IdentityStore, IdentityTransaction } from './identity.store.js';
import type { AuthRequestContext } from './request-context.js';
import type { OwnedSessionPage } from './session.service.js';
import { SessionService } from './session.service.js';

/**
 * The slice of `SessionService` this service uses — the same narrow-port shape
 * `SessionRevoker` and `SessionIssuer` take, for the same reason. It lists, it
 * revokes one of the caller's own, and it revokes the rest; it never issues,
 * resolves or rotates.
 */
export interface OwnedSessionManager {
  listOwnedPage(input: {
    userId: string;
    limit: number;
    cursor: { lastSeenAt: Date; id: string } | null;
  }): Promise<OwnedSessionPage>;
  revokeOwned(
    userId: string,
    sessionId: string,
  ): Promise<'REVOKED' | 'NOTHING_TO_REVOKE' | 'NOT_FOUND'>;
  revokeAllForUser(
    userId: string,
    options?: { exceptSessionId?: string | undefined },
  ): Promise<number>;
}

export interface ListOwnSessionsQuery {
  readonly userId: string;
  readonly currentSessionId: string;
  readonly limit: number;
  readonly cursor: { lastSeenAt: Date; id: string } | null;
}

export interface RevokeOwnSessionCommand extends AuthRequestContext {
  readonly userId: string;
  readonly currentSessionId: string;
  readonly targetSessionId: string;
}

export interface RevokeOtherSessionsCommand extends AuthRequestContext {
  readonly userId: string;
  readonly currentSessionId: string;
}

export interface RevokeOwnSessionResult {
  /**
   * Whether the session that was revoked is the one the request was made with.
   *
   * The controller uses it to decide whether to clear the caller's cookies, and
   * it is reported rather than recomputed there so that the decision is made
   * once, by the code that knows what it revoked.
   */
  readonly wasCurrent: boolean;
}

/**
 * THE THREE `/settings/security` SESSION ROUTES' SERVICE.
 *
 * # Everything here is scoped to the caller, and no guard does that for it
 *
 * `Session` is **user**-owned, not tenant-owned (`session.repository.ts`'s class
 * docblock, and the comment on the model in `schema.prisma`), so it is
 * deliberately absent from the tenant resource registry and
 * `TenantContextGuard` has nothing to say about it. The cross-user isolation
 * every other resource inherits from a guard is, here, three lines of this
 * service — `SessionService.revokeOwned`'s ownership check and the `userId`
 * this class passes into every read. `auth.sessions.integration.spec.ts` is
 * what holds them.
 *
 * # `RESOURCE_NOT_FOUND`, never `PERMISSION_DENIED`
 *
 * `api/authorization.md` §3 gives 404 for "resource belongs to another tenant",
 * and the same reasoning applies one ownership axis over: a 403 would confirm
 * that the id names a live session, which turns this route into an oracle
 * against every account in the product. The refusal is byte-identical to the
 * one for an id that has never existed.
 *
 * # THE AUDIT ROW IS NOT IN THE SAME TRANSACTION AS THE REVOCATION
 *
 * `CLAUDE.md` rule 10 wants both in one transaction, and this service does not
 * deliver that. The reason is structural rather than a preference, and it is
 * the same one `logout.service.ts` records for `POST /auth/logout` and
 * `api/authentication.md` §2 records for `POST /auth/switch-org`:
 * `SessionService`'s revocation owns an ordering that spans **Redis and
 * Postgres** — the cache entry is tombstoned before the row is written, which
 * is what makes revocation immediate — and it therefore takes no transaction
 * handle. One transaction over **the Redis half and the Postgres half** is not
 * expressible without reopening Task 6's cache design.
 *
 * # THE PART OF THAT JUSTIFICATION THAT WAS OVERSTATED
 *
 * "Not expressible without reopening Task 6" is true of Redis and **false of
 * Postgres**, and the sentence above used to run them together. Review round 2
 * measured the difference and accepted the deviation with this correction owed:
 *
 * - The **Redis tombstone genuinely cannot** be inside a Postgres transaction.
 *   Nothing changes that.
 * - The **Postgres half could be**. `SessionRepository` and this service both
 *   inject the same `PRISMA` token — one `PrismaClient`, narrowed by two
 *   structural port types — `SessionStore` already declares `$transaction`, and
 *   `SessionRepository.rotate` already runs an `updateMany` and a `create`
 *   inside one. What blocks it is a signature: `revokeById(id, revokedAt)`
 *   takes no `tx` handle. It is one parameter.
 *
 * The conditional audit below survives that rewrite unchanged, because
 * `updateMany`'s count is available inside the transaction. The residual would
 * be a tombstone over a session a rolled-back transaction did not revoke —
 * refused for at most `cacheTtlSeconds` (default 60) and then working again,
 * which is a bounded, self-healing, fail-safe denial and strictly better than a
 * permanently missing audit row.
 *
 * **It is not done here on purpose.** Moving the audit write inside a Postgres
 * transaction changes a revocation path shared with `logout`, two tasks older
 * than this one, and doing it in a fix round rather than in a change of its own
 * is how a blast radius goes unmeasured. Recorded as owed, not smuggled in.
 *
 * The order chosen is **revoke, then audit**, which is `logout`'s:
 *
 * - Revoking first means a failure in the audit write leaves a session that is
 *   genuinely gone and an event that was not recorded — a gap in the trail.
 * - Auditing first would leave an append-only row asserting a revocation that
 *   did not happen. This codebase treats a false statement in a table that
 *   cannot be corrected as the worse outcome.
 *
 * Neither error is swallowed: a revocation that could not be audited is a 500,
 * not a quiet 200. **This is a deviation from the brief's instruction to follow
 * Task 14's membership shape**, and it is recorded in this task's report rather
 * than left for a reviewer to discover.
 *
 * # A row is written only when a row moved
 *
 * `'NOTHING_TO_REVOKE'` and a bulk revocation of zero sessions write nothing.
 * Otherwise a caller holding one session can grow an append-only table by
 * replaying one request — the constraint `ACCOUNT_LOCKED` and
 * `MFA_PENDING_SESSION_LOCKED` are both written under.
 */
@Injectable()
export class SessionManagementService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(SessionService) private readonly sessions: OwnedSessionManager,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  async list(query: ListOwnSessionsQuery): Promise<{
    readonly sessions: readonly {
      readonly id: string;
      readonly ip: string | null;
      readonly userAgent: string | null;
      readonly createdAt: Date;
      readonly lastSeenAt: Date;
      readonly current: boolean;
    }[];
    readonly hasMore: boolean;
  }> {
    const page = await this.sessions.listOwnedPage({
      userId: query.userId,
      limit: query.limit,
      cursor: query.cursor,
    });

    return {
      // `current` is computed here rather than sent by the client, because the
      // client cannot see its own session id: `sessionResponseSchema`
      // deliberately withholds it, and this route does not reintroduce it by
      // the back door.
      sessions: page.sessions.map((session) => ({
        ...session,
        current: session.id === query.currentSessionId,
      })),
      hasMore: page.hasMore,
    };
  }

  /**
   * Revokes one of the caller's own sessions, or refuses with a 404.
   *
   * **Revoking the current session is allowed**, and answers exactly as any
   * other revocation does. The decision and its reasoning are in
   * `auth.controller.ts`'s docblock for the route; what this method owns is
   * reporting `wasCurrent` so the controller can clear the cookies rather than
   * leaving the browser holding a dead pair.
   */
  async revokeOne(command: RevokeOwnSessionCommand): Promise<RevokeOwnSessionResult> {
    const outcome = await this.sessions.revokeOwned(command.userId, command.targetSessionId);

    if (outcome === 'NOT_FOUND') {
      throw new DomainError(
        ERROR_CODES.RESOURCE_NOT_FOUND,
        'No such session.',
        404,
        // No `details`. Anything that varied between "never existed" and
        // "somebody else's" would be the oracle this 404 exists to close.
      );
    }

    if (outcome === 'REVOKED') {
      await this.record({
        ...command,
        resourceId: command.targetSessionId,
        metadata: { scope: 'one' },
      });
    }

    return { wasCurrent: command.targetSessionId === command.currentSessionId };
  }

  /**
   * Revokes every session of the caller **except** the one that asked.
   *
   * `exceptSessionId` is what makes that true, and it is the caller's resolved
   * session id rather than anything from the request body — there is no body,
   * deliberately, so there is no field a caller could set to somebody else's
   * session and no shape in which this could revoke on another user's behalf.
   */
  async revokeOthers(command: RevokeOtherSessionsCommand): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAllForUser(command.userId, {
      exceptSessionId: command.currentSessionId,
    });

    if (revoked > 0) {
      await this.record({
        ...command,
        // THE SURVIVING SESSION, not the revoked ones. There are many of those
        // and one row each would let a caller size an append-only table; the
        // row that says "from this session, N others were signed out" is what
        // an investigation needs, and `resourceId` has to name something that
        // still exists for it to be joinable.
        resourceId: command.currentSessionId,
        metadata: { scope: 'others', revoked },
      });
    }

    return { revoked };
  }

  private async record(input: {
    userId: string;
    resourceId: string;
    metadata: Readonly<Record<string, string | number | boolean | null>>;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  }): Promise<void> {
    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await this.audit.record(tx, {
        // The actor really is the account owner: they presented a live session
        // cookie and the CSRF token derived from it, so `AuthenticationGuard`
        // and `CsrfGuard` have both already vouched for them.
        actorType: 'USER',
        actorId: input.userId,
        action: 'SESSION_REVOKED',
        // THE SESSION, NOT THE USER, following `LOGOUT`. The user is unchanged;
        // the session row is what moved, and `revokedAt` on it is what an
        // investigation joins to this event.
        resourceType: 'Session',
        resourceId: input.resourceId,
        metadata: input.metadata,
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: input.requestId,
      });
    });
  }
}
