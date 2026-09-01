import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '@sentinel/config';
import { createLogger } from '@sentinel/observability';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import {
  identityStoreFake,
  type IdentityStoreFake,
  identityUserRow,
  mailerFake,
  type MailerFake,
} from '../../testing/identity-fakes.js';
import { BreachCheckService } from './breach-check.service.js';
import { InvalidCredentialsError } from './invalid-credentials.error.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordChangeService } from './password-change.service.js';
import { PasswordService } from './password.service.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * WHAT THE FAKES CAN SHOW HERE, AND WHAT THEY DELIBERATELY DO NOT.
 *
 * The same division `password-reset.service.spec.ts` records. The fake's
 * compare-and-swap is honest about its own state, so the REFUSING half of D3 is
 * reachable; what it cannot model is two callers racing, because there is no
 * row lock and no second request. `auth.password.integration.spec.ts` fires two
 * change-password requests in one `Promise.all` against real Postgres and
 * requires exactly one to commit — carry-forward ruling 74, a test about two
 * requests has to BE two requests.
 *
 * What this file is for is the ordering and branching a database cannot show:
 * that the new hash is committed before anything is revoked (D2), that the
 * caller's own session is rotated rather than killed while every other one is
 * revoked, that a wrong current password writes a denial row (D9), and that the
 * notice is sent after the commit.
 */

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

/** Carry-forward ruling 22: the properties here are parameter-independent. */
const ARGON2 = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

const CONTEXT = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

const CURRENT_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new correct horse battery staple';
const SESSION_ID = 'ses_01M0T74WZZFY9T2QS56RGF3GQ7';

/** See `password-reset.service.spec.ts` — the range response is keyed by this. */
const suffixOf = (password: string): string =>
  createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase().slice(5);

interface RotateCall {
  readonly sessionId: string;
  readonly status: string;
}

interface Harness {
  readonly service: PasswordChangeService;
  readonly db: IdentityStoreFake;
  readonly mail: MailerFake;
  readonly passwords: PasswordService;
  readonly revoked: { userId: string; exceptSessionId: string | undefined }[];
  readonly rotations: RotateCall[];
  /** Set to make `rotate` report that there was nothing left to rotate. */
  readonly control: { rotateReturnsNull: boolean };
}

function harness(options: { breached?: boolean } = {}): Harness {
  const db = identityStoreFake();
  const mail = mailerFake();
  const logger = createLogger({ service: 'test', level: 'fatal', pretty: false, silent: true });
  const tokens = new TokenService(db.tokenStore, TTL);
  const passwords = new PasswordService(ARGON2);
  const revoked: { userId: string; exceptSessionId: string | undefined }[] = [];
  const rotations: RotateCall[] = [];
  const control = { rotateReturnsNull: false };
  const sessions = {
    revokeAllForUser: (userId: string, opts: { exceptSessionId?: string | undefined } = {}) => {
      // Into the SAME list the store fake records into, so the ordering
      // assertions compare one sequence rather than two clocks.
      db.calls.push({ name: 'sessions.revokeAllForUser', args: { ...opts } });
      revoked.push({ userId, exceptSessionId: opts.exceptSessionId });
      return Promise.resolve(revoked.length);
    },
    rotate: (input: { sessionId: string; status: 'ACTIVE' }) => {
      db.calls.push({ name: 'sessions.rotate', args: input });
      rotations.push({ sessionId: input.sessionId, status: input.status });
      return Promise.resolve(
        control.rotateReturnsNull
          ? null
          : { token: 'FIXTURE_rotated_session_token', cookieMaxAgeSeconds: 604_800 },
      );
    },
  };
  const breachCheck = new BreachCheckService(
    { enabled: options.breached === true, rangeUrl: 'https://breach.invalid/range', timeoutMs: 50 },
    () => Promise.resolve({ status: 200, body: `${suffixOf(NEW_PASSWORD)}:42` }),
    logger,
  );
  const mailer = new AuthMailer(mail.mailer, ENV, tokens, logger);
  const service = new PasswordChangeService(
    db.store,
    passwords,
    breachCheck,
    new PlatformAuditService(),
    mailer,
    sessions,
  );
  return { service, db, mail, passwords, revoked, rotations, control };
}

async function withAccount(db: IdentityStoreFake, passwords: PasswordService) {
  const row = identityUserRow({ name: 'Ada Lovelace', emailVerifiedAt: new Date() });
  db.users.set(row.email, row);
  db.users.set(row.id, row);
  db.credentials.set(row.id, await passwords.hash(CURRENT_PASSWORD));
  return row;
}

const names = (db: IdentityStoreFake): string[] => db.calls.map((call) => call.name);

const auditRows = (db: IdentityStoreFake): Record<string, unknown>[] =>
  db.calls
    .filter((call) => call.name === 'tx.platformAuditEvent.create')
    .map((call) => call.args as Record<string, unknown>);

const command = (overrides: Record<string, unknown> = {}) => ({
  userId: identityUserRow().id,
  sessionId: SESSION_ID,
  currentPassword: CURRENT_PASSWORD,
  newPassword: NEW_PASSWORD,
  ...CONTEXT,
  ...overrides,
});

describe('change-password — the current password must be proved', () => {
  it('refuses a wrong current password with INVALID_CREDENTIALS', async () => {
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await expect(
      service.change(command({ currentPassword: 'not the current password' })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(names(db)).not.toContain('tx.credential.updateMany');
  });

  it('WRITES A DENIAL ROW for a wrong current password', async () => {
    // D9, and `security/audit.md` §3's "failures and denials are audited".
    // Task 9's M2 was exactly this gap one endpoint over: a refusal that
    // produced a 403 and zero rows. It is the sharper of the two credential
    // failures — reaching it costs a live session, so an anonymous caller
    // cannot produce it at will.
    const { service, db, passwords } = harness();
    const user = await withAccount(db, passwords);

    await expect(
      service.change(command({ currentPassword: 'not the current password' })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PASSWORD_CHANGE_FAILED',
      // `SYSTEM` with a null actor, like every other failure row in this
      // codebase: whoever is holding the session could not produce the
      // password, and that is the entire reason the row is interesting.
      actorType: 'SYSTEM',
      actorId: null,
      resourceType: 'User',
      resourceId: user.id,
    });
  });

  it('puts neither password in the denial row', async () => {
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await expect(
      service.change(command({ currentPassword: 'wrong wrong wrong' })),
    ).rejects.toThrow();

    const serialised = JSON.stringify(auditRows(db));
    expect(serialised).not.toContain('wrong wrong wrong');
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain('$argon2id$');
  });

  it('pays the Argon2id verification even when the account has NO credential row', async () => {
    // Carry-forward ruling 21. `PasswordService.verify` takes a nullable stored
    // hash and verifies against a dummy when it is null, so this service cannot
    // express "no credential, skip the hash" without deliberately not calling
    // it. The refusal is the same 401 either way.
    const { service, db } = harness();
    const row = identityUserRow();
    db.users.set(row.id, row);

    await expect(service.change(command())).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(names(db)).toContain('credential.findUnique');
    expect(names(db)).not.toContain('tx.credential.updateMany');
  });

  it('revokes nothing and rotates nothing on a refusal', async () => {
    const { service, db, passwords, revoked, rotations } = harness();
    await withAccount(db, passwords);

    await expect(service.change(command({ currentPassword: 'nope nope nope' }))).rejects.toThrow();

    expect(revoked).toEqual([]);
    expect(rotations).toEqual([]);
  });
});

describe('change-password — the burst notice (M3)', () => {
  /**
   * THE ROW THE REVIEW FILLED IN.
   *
   * `login` bounds guessing per account (5 / 15 min), locks the account, and
   * tells the owner. `change-password` deliberately does none of the first two
   * — the argument for staying out of the lockout ladder stands, because a
   * session thief who could lock the account gains a denial of service — but it
   * was also telling the owner **nothing at all**, on the one endpoint that
   * proves a password while requiring only a stolen session.
   *
   * So the signal is added without the ladder: consecutive refusals are counted
   * from the `PASSWORD_CHANGE_FAILED` rows this service already writes, and the
   * owner gets `failedLoginBurst` once per burst. Nothing touches
   * `User.failedLoginCount`, which is the whole point — a counter a session
   * thief can move is a lockout they can inflict.
   */
  async function fail(service: PasswordChangeService, times: number): Promise<void> {
    for (let attempt = 0; attempt < times; attempt += 1) {
      await expect(
        service.change(command({ currentPassword: 'wrong wrong wrong' })),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
  }

  it('sends nothing for four refused attempts', async () => {
    const { service, db, mail, passwords } = harness();
    await withAccount(db, passwords);

    await fail(service, 4);

    expect(mail.sent).toEqual([]);
  });

  it('sends ONE failedLoginBurst on the fifth', async () => {
    const { service, db, mail, passwords } = harness();
    await withAccount(db, passwords);

    await fail(service, 5);

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['failedLoginBurst']);
  });

  it('sends only that one, however many attempts follow', async () => {
    // Once per burst, not once per failure past it. A message per failure would
    // make this notice an outbound-email amplifier aimed at the account owner,
    // triggered at will by whoever holds the session — the same rule `login`'s
    // burst notice follows, and the same reason.
    const { service, db, mail, passwords } = harness();
    await withAccount(db, passwords);

    await fail(service, 8);

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['failedLoginBurst']);
  });

  it('NEVER touches the failure counter or the lock', async () => {
    // The constraint the disposition names, and the reason this counts audit
    // rows rather than a column: a session thief who could move
    // `User.failedLoginCount` could lock the owner out of `login` outright,
    // which is a denial of service handed to exactly the party this endpoint is
    // defending against.
    const { service, db, passwords } = harness();
    const user = await withAccount(db, passwords);

    await fail(service, 6);

    const row = db.users.get(user.id);
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
    expect(names(db)).not.toContain('tx.user.updateMany');
  });

  it('does not vary the response on the attempt that sends it', async () => {
    // The response must be the same 401 on every refused attempt. A different
    // status, code or message on the fifth would tell whoever is guessing
    // exactly where the threshold is.
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await service.change(command({ currentPassword: 'nope' }));
        errors.push(null);
      } catch (error: unknown) {
        errors.push(error);
      }
    }

    for (const error of errors) {
      expect(error).toBeInstanceOf(InvalidCredentialsError);
    }
  });

  it('renders nothing an attacker supplied in the notice', async () => {
    // `failedLoginBurst` takes `{ occurredAt, attemptCount }` and nothing else —
    // both ours. Asserted with a hostile stored name present on the row, since
    // this notice goes to the account owner while the attempts are somebody
    // else's.
    const { service, db, mail, passwords } = harness();
    const user = await withAccount(db, passwords);
    const hostile = { ...user, name: 'Ada <script>alert(1)</script> https://evil.test/x' };
    db.users.set(user.id, hostile);
    db.users.set(user.email, hostile);

    await fail(service, 5);

    const sent = mail.sent[0];
    for (const part of [sent?.subject ?? '', sent?.html ?? '', sent?.text ?? '']) {
      expect(part).not.toContain('evil.test');
      expect(part).not.toContain('alert(1)');
    }
  });

  it('sends AFTER the transaction has committed', async () => {
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await fail(service, 5);

    const order = names(db);
    expect(order.lastIndexOf('$transaction:commit')).toBeGreaterThan(
      order.lastIndexOf('tx.platformAuditEvent.count'),
    );
  });

  it('resets after a SUCCESSFUL change, because the window counts refusals only', async () => {
    // Four refusals, then a success, then four more must not trip it: the count
    // is of `PASSWORD_CHANGE_FAILED` rows, and a success writes none.
    const { service, db, mail, passwords } = harness();
    await withAccount(db, passwords);

    await fail(service, 4);
    await service.change(command());
    mail.sent.length = 0;
    await fail(service, 4);

    expect(mail.sent).toEqual([]);
  });
});

describe('change-password — the accepted path', () => {
  it('replaces the credential with a hash of the NEW password', async () => {
    const { service, db, passwords } = harness();
    const user = await withAccount(db, passwords);

    await service.change(command());

    const stored = db.credentials.get(user.id);
    expect((await passwords.verify(stored ?? null, NEW_PASSWORD)).valid).toBe(true);
    expect((await passwords.verify(stored ?? null, CURRENT_PASSWORD)).valid).toBe(false);
  });

  it('WRITES AND COMMITS THE NEW HASH BEFORE ANYTHING IS REVOKED', async () => {
    // D2. A revoke-then-write ordering leaves a window in which the old
    // password still mints sessions the revocation has already passed over.
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await service.change(command());

    const order = names(db);
    const written = order.indexOf('tx.credential.updateMany');
    const committed = order.indexOf('$transaction:commit');
    const revokedAt = order.indexOf('sessions.revokeAllForUser');
    expect(written).toBeGreaterThan(-1);
    expect(revokedAt).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(written);
    expect(revokedAt).toBeGreaterThan(committed);
  });

  it('revokes every OTHER session and rotates the one in hand', async () => {
    // D2's second half. Losing your own session on a password change is a
    // usability bug; keeping every other one is a security bug.
    // `security/authentication.md` §3 lists a password change as a privilege
    // change, so the rotation is required rather than cosmetic.
    const { service, db, passwords, revoked, rotations } = harness();
    const user = await withAccount(db, passwords);

    const result = await service.change(command());

    expect(revoked).toEqual([{ userId: user.id, exceptSessionId: SESSION_ID }]);
    // `status` stated explicitly — carry-forward ruling 6. `Session.status` has
    // no `@default`, so forgetting it is a compile error rather than a silently
    // privileged session.
    expect(rotations).toEqual([{ sessionId: SESSION_ID, status: 'ACTIVE' }]);
    expect(result.token).toBe('FIXTURE_rotated_session_token');
    expect(result.cookieMaxAgeSeconds).toBe(604_800);
  });

  it('revokes the others BEFORE rotating, so the caller is the only survivor throughout', async () => {
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await service.change(command());

    const order = names(db);
    expect(order.indexOf('sessions.rotate')).toBeGreaterThan(
      order.indexOf('sessions.revokeAllForUser'),
    );
  });

  it('reports no token when the caller session was concurrently revoked', async () => {
    // `rotate` returns `null` when there was nothing to rotate. The password IS
    // changed by then, so this is not an error — the honest answer is to report
    // no replacement cookie and let the controller clear the ones the caller
    // has, which signs them out rather than leaving a dead cookie in place.
    const { service, db, passwords, control } = harness();
    await withAccount(db, passwords);
    control.rotateReturnsNull = true;

    const result = await service.change(command());

    expect(result.token).toBeNull();
    expect(result.cookieMaxAgeSeconds).toBeNull();
  });

  it('refuses a breached NEW password, and changes nothing', async () => {
    const { service, db, passwords, revoked } = harness({ breached: true });
    const user = await withAccount(db, passwords);
    const before = db.credentials.get(user.id);

    await expect(service.change(command())).rejects.toBeInstanceOf(PasswordBreachedError);
    expect(db.credentials.get(user.id)).toBe(before);
    expect(revoked).toEqual([]);
  });

  it('checks the breach corpus only AFTER the current password is proved', async () => {
    // Otherwise the endpoint answers 422 for a caller who cannot prove the
    // current password — which tells somebody holding a stolen session that the
    // password they guessed is in a breach corpus, and does it before they have
    // shown they may ask anything about this account at all.
    const { service, db, passwords } = harness({ breached: true });
    await withAccount(db, passwords);

    await expect(
      service.change(command({ currentPassword: 'not the current password' })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('refuses when the credential moved under it, and changes nothing', async () => {
    // D3 and carry-forward ruling 73. Two concurrent changes both verify
    // against the same old hash; without the predicate both commit and the
    // user's password is whichever request happened to land last.
    const { service, db, passwords, revoked } = harness();
    const user = await withAccount(db, passwords);
    const sibling = await passwords.hash('a sibling got there first');
    db.control.replaceCredentialAfterRead = { userId: user.id, passwordHash: sibling };

    await expect(service.change(command())).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(db.credentials.get(user.id)).toBe(sibling);
    expect(revoked).toEqual([]);
  });

  it('writes one PASSWORD_CHANGED row carrying the live session count', async () => {
    const { service, db, passwords } = harness();
    const user = await withAccount(db, passwords);
    db.liveSessionCounts.set(user.id, 4);

    await service.change(command());

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PASSWORD_CHANGED',
      // The actor really is the account owner here, unlike the reset: they
      // presented a live session, the CSRF token derived from it, AND the
      // existing password.
      actorType: 'USER',
      actorId: user.id,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { liveSessionsAtWrite: 4 },
    });
  });

  it('counts the OTHER sessions, excluding the one being rotated', async () => {
    const { service, db, passwords } = harness();
    await withAccount(db, passwords);

    await service.change(command());

    const counted = db.calls.find((call) => call.name === 'tx.session.count');
    expect(counted?.args).toMatchObject({ revokedAt: null, id: { not: SESSION_ID } });
  });

  it('sends the password-changed notice after the commit', async () => {
    const { service, db, mail, passwords } = harness();
    await withAccount(db, passwords);

    await service.change(command());

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['passwordChanged']);
    const order = names(db);
    expect(order.indexOf('sessions.revokeAllForUser')).toBeGreaterThan(
      order.indexOf('$transaction:commit'),
    );
  });

  it('renders no display name in the notice, even a hostile one', async () => {
    // Ruling 70, closed. `AuthMailer.sendPasswordChanged` has no parameter for
    // a name, so this cannot regress without a signature change — asserted
    // anyway with a hostile name actually present on the row, because what
    // reaches the body is the thing that matters.
    const { service, db, mail, passwords } = harness();
    const user = await withAccount(db, passwords);
    const hostile = { ...user, name: 'Ada <script>alert(1)</script> https://evil.test/x' };
    db.users.set(user.id, hostile);
    db.users.set(user.email, hostile);

    await service.change(command());

    const sent = mail.sent[0];
    expect(sent).toBeDefined();
    for (const part of [sent?.subject ?? '', sent?.html ?? '', sent?.text ?? '']) {
      expect(part).not.toContain('evil.test');
      expect(part).not.toContain('alert(1)');
    }
  });

  it('does not let a failed notice send undo the change', async () => {
    const { service, db, mail, passwords, revoked } = harness();
    const user = await withAccount(db, passwords);
    mail.control.failWith = new Error('relay refused');

    await expect(service.change(command())).resolves.toMatchObject({
      token: 'FIXTURE_rotated_session_token',
    });
    expect(revoked).toHaveLength(1);
    expect((await passwords.verify(db.credentials.get(user.id) ?? null, NEW_PASSWORD)).valid).toBe(
      true,
    );
  });
});
