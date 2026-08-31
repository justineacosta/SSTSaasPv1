import { describe, expect, it } from 'vitest';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { identityStoreFake, type IdentityStoreFake } from '../../testing/identity-fakes.js';
import { LogoutService, type SessionRevoker } from './logout.service.js';

/**
 * LOGOUT'S ORDERING, AND THE THING IT DELIBERATELY DOES NOT DO.
 *
 * The revocation itself — the tombstone, the compare-and-set that refuses to
 * overwrite one, the affected-row count that arbitrates two concurrent
 * logouts — is `SessionService`'s and is proved against real Postgres and real
 * Redis in `session.service.integration.spec.ts`. What is asserted here is what
 * logout DECIDES: that it revokes rather than deletes, that it revokes before
 * it audits, and that a session that was already gone is still a success.
 */

const COMMAND = {
  userId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  sessionId: 'ses_01M0T74WZZFY9T2QS56RGF3GQ7',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

function harness(options: { revoked?: boolean; revokeError?: Error } = {}) {
  const db = identityStoreFake();
  const calls: string[] = [];
  const revoker: SessionRevoker = {
    revoke: (sessionId) => {
      calls.push(`revoke:${sessionId}`);
      if (options.revokeError !== undefined) return Promise.reject(options.revokeError);
      return Promise.resolve(options.revoked ?? true);
    },
  };
  const service = new LogoutService(db.store, revoker, new PlatformAuditService());
  return { service, db, calls, revoker };
}

const auditEvent = (db: IdentityStoreFake): Record<string, unknown> | undefined =>
  db.calls.find((call) => call.name === 'tx.platformAuditEvent.create')?.args as
    Record<string, unknown> | undefined;

describe('LogoutService.logout', () => {
  it('revokes the caller’s own session', async () => {
    const { service, calls } = harness();
    await service.logout(COMMAND);
    expect(calls).toEqual([`revoke:${COMMAND.sessionId}`]);
  });

  it('writes one LOGOUT event naming the SESSION as the resource', async () => {
    // Not the user. A logout changes nothing about the user, and `revokedAt` on
    // the session row is what an investigation joins this event to.
    const { service, db } = harness();
    await service.logout(COMMAND);

    expect(auditEvent(db)).toMatchObject({
      actorType: 'USER',
      actorId: COMMAND.userId,
      action: 'LOGOUT',
      resourceType: 'Session',
      resourceId: COMMAND.sessionId,
      ip: COMMAND.ip,
      userAgent: COMMAND.userAgent,
      requestId: COMMAND.requestId,
    });
  });

  it('carries no metadata at all', async () => {
    // Everything worth recording is already a column. A `{ revoked: true }`
    // would restate the action name, and `security/audit.md` §5's redaction
    // rule is easiest to satisfy with a field that does not exist.
    const { service, db } = harness();
    await service.logout(COMMAND);
    expect(auditEvent(db)?.['metadata']).toEqual({});
  });

  it('revokes BEFORE it audits', async () => {
    // D7's compromise, asserted rather than described. One transaction covering
    // both is not expressible — `SessionService.revoke` takes no transaction
    // handle, deliberately, because it owns an ordering spanning Redis and
    // Postgres — so the choice is which failure to prefer. Auditing first would
    // mean a failed revocation leaves an append-only row asserting a logout
    // that did not happen, and a false statement in that table is the worse
    // outcome.
    const { service, db, calls } = harness();
    await service.logout(COMMAND);

    expect(calls[0]).toBe(`revoke:${COMMAND.sessionId}`);
    expect(db.calls.map((call) => call.name)).toEqual([
      '$transaction:begin',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
  });

  it('writes no audit row when the revocation itself fails', async () => {
    const { service, db } = harness({ revokeError: new Error('redis and postgres both down') });
    await expect(service.logout(COMMAND)).rejects.toThrow('redis and postgres both down');
    expect(auditEvent(db)).toBeUndefined();
  });

  it('treats "there was nothing live to revoke" as success', async () => {
    // `revoke` returns `false` when the session was already revoked or already
    // past either clock. The end state the caller asked for is the end state
    // they have. It still audits: the caller did perform a logout, and a
    // concurrent revocation winning the race is not a reason to lose the event.
    const { service, db } = harness({ revoked: false });
    await expect(service.logout(COMMAND)).resolves.toBeUndefined();
    expect(auditEvent(db)).toMatchObject({ action: 'LOGOUT' });
  });

  it('does not propagate a failed audit write as a silent success', async () => {
    // The other half of the compromise. A logout that could not be audited is a
    // 500, not a quiet 204: the session is genuinely revoked, so the user is
    // safe, and the operator is told the trail has a hole rather than left to
    // find it later.
    const { service, db } = harness();
    db.control.failTransaction = new Error('commit refused');
    await expect(service.logout(COMMAND)).rejects.toThrow('commit refused');
  });
});
