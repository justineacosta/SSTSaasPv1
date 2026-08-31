import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import type { IdentityStore, IdentityTransaction } from './identity.store.js';
import type { AuthRequestContext } from './request-context.js';
import { SessionService } from './session.service.js';

/**
 * The slice of `SessionService` logout uses — the same narrow-port shape
 * `SessionIssuer` and `SessionResolver` take, for the same reason.
 */
export interface SessionRevoker {
  revoke(sessionId: string): Promise<boolean>;
}

export interface LogoutCommand extends AuthRequestContext {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * `POST /api/v1/auth/logout` — 204, both cookies cleared, the session revoked.
 *
 * # REVOKED, NOT DELETED, AND THE DOCUMENT IS WHAT CHANGED
 *
 * D7. `api/authentication.md` §2 said "session row deleted" and the Phase 2
 * plan repeated it; both are corrected in the same change as this file.
 * `SessionService.revoke` sets `revokedAt` and tombstones the cache entry, and
 * that is the behaviour to keep:
 *
 * - the row is the forensic record that a session existed, and an incident
 *   review reconstructs `rotatedFromId` chains from rows a delete would have
 *   removed;
 * - `Session.revokedAt` is what `/settings/security` (Task 17) reads to show a
 *   user their signed-out devices;
 * - a delete would take the audit row's `resourceId` with it, leaving a
 *   `LOGOUT` event pointing at nothing.
 *
 * **The property that mattered is immediacy, and it is unchanged.** `revoke`
 * poisons the cache key *before* it writes the row, so no warm cache entry can
 * serve the session after this returns — Task 6's tombstone plus the Lua
 * compare-and-set that refuses to overwrite one. Task 6's ruling 52 records the
 * single residual nobody here can close: Redis unreachable at the moment of
 * revocation, bounded by `SESSION_CACHE_TTL_SECONDS`.
 *
 * # `false` is success
 *
 * `revoke` returns `false` when there was nothing live to revoke — a session
 * already revoked, or already past either clock. The end state the caller asked
 * for is the end state they have, so this still answers 204 and still clears
 * the cookies. A caller cannot reach this method at all without a live session
 * (the authentication guard refuses first), so `false` here means a concurrent
 * revocation won, which is not an error.
 *
 * # The audit row is NOT in the same transaction as the revocation, and that is
 * a compromise rather than a design
 *
 * `CLAUDE.md` rule 10 wants both in one transaction. `SessionService.revoke`
 * takes no transaction handle — deliberately, since it owns an ordering that
 * spans Redis and Postgres — so one transaction covering both is not expressible
 * without reopening Task 6. The order chosen is **revoke, then audit**:
 *
 * - Revoking first means a failure in the audit write leaves a session that is
 *   genuinely gone and an event that was not recorded. That is a gap in the
 *   trail.
 * - Auditing first would mean a failure in the revocation leaves an append-only
 *   row asserting a logout that did not happen. This codebase treats a false
 *   statement in an append-only table as the worse outcome (see
 *   `registration.service.ts` on why a failed login names no actor), so the gap
 *   is preferred to the lie.
 *
 * Neither error is swallowed: both propagate, and a logout that could not be
 * audited is a 500 rather than a quiet 204. Recorded in this task's report as a
 * decision the brief did not make.
 */
@Injectable()
export class LogoutService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(SessionService) private readonly sessions: SessionRevoker,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  async logout(command: LogoutCommand): Promise<void> {
    await this.sessions.revoke(command.sessionId);

    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await this.audit.record(tx, {
        // The actor really is the user: they presented a live session cookie
        // and the CSRF token derived from it, so the authentication guard and
        // `CsrfGuard` have both already vouched for them.
        actorType: 'USER',
        actorId: command.userId,
        action: 'LOGOUT',
        // THE SESSION, NOT THE USER. The user is unchanged by a logout; the
        // session row is the thing that moved, and `revokedAt` on it is what an
        // investigation will want to join to this event.
        resourceType: 'Session',
        resourceId: command.sessionId,
        // Empty. Everything worth recording is already a column: who, which
        // session, from where, and when. A `{ revoked: true }` would restate
        // the action name.
        metadata: {},
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });
  }
}
