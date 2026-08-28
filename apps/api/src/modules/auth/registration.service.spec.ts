import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@sentinel/observability';
import type { ApiEnv } from '@sentinel/config';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { BreachCheckService } from './breach-check.service.js';
import {
  identityStoreFake,
  type IdentityStoreFake,
  mailerFake,
  type MailerFake,
} from '../../testing/identity-fakes.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordService } from './password.service.js';
import { RegistrationService } from './registration.service.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * REGISTRATION'S ORDERING AND BRANCHING, WHERE A DATABASE CANNOT SHOW THEM.
 *
 * Single use, supersession and the append-only trigger are properties of
 * Postgres and are asserted in the integration lane. What is asserted here is
 * what the fakes make visible and a real database would hide: the exact
 * sequence of `$transaction:begin`, the writes, `$transaction:commit`, and only
 * then the send.
 */

/** Reduced Argon2 parameters. The property under test is not the cost. */
const ARGON2 = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const silentLogger = () =>
  createLogger({ service: 'test', level: 'fatal', pretty: false, silent: true });

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

const COMMAND = {
  email: 'ada@example.test',
  password: 'correct horse battery staple',
  name: 'Ada Lovelace',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

interface Harness {
  readonly service: RegistrationService;
  readonly db: IdentityStoreFake;
  readonly mail: MailerFake;
  readonly passwords: PasswordService;
  readonly breached: { value: boolean };
}

function harness(): Harness {
  const db = identityStoreFake();
  const mail = mailerFake();
  const passwords = new PasswordService(ARGON2);
  const tokens = new TokenService(db.tokenStore, TTL);
  const breached = { value: false };
  // The transport is never reached: `isBreached` returns early when the check
  // is disabled, and the two tests that need a positive answer stub the method
  // rather than standing up a fake HIBP.
  const breachCheck = new BreachCheckService(
    { enabled: false, rangeUrl: 'https://example.invalid', timeoutMs: 10 },
    () => Promise.reject(new Error('the transport must not be reached')),
    silentLogger(),
  );
  vi.spyOn(breachCheck, 'isBreached').mockImplementation(() => Promise.resolve(breached.value));

  const mailer = new AuthMailer(mail.mailer, ENV, tokens, silentLogger());
  const service = new RegistrationService(
    db.store,
    passwords,
    breachCheck,
    tokens,
    new PlatformAuditService(),
    mailer,
  );
  return { service, db, mail, passwords, breached };
}

const names = (db: IdentityStoreFake): string[] => db.calls.map((call) => call.name);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a new address', () => {
  it('writes the user, the credential, the token and the audit event in ONE transaction', async () => {
    // `security/audit.md` §2: the event is written in the same transaction as
    // the change. Asserted as a sequence rather than as four separate calls,
    // because four calls that each happened is not evidence they happened
    // together.
    const { service, db } = harness();
    await service.register(COMMAND);

    const sequence = names(db).slice(names(db).indexOf('$transaction:begin'));
    expect(sequence).toEqual([
      '$transaction:begin',
      'tx.user.create',
      'tx.credential.create',
      'tx.$queryRaw',
      'tx.verificationToken.updateMany',
      'tx.verificationToken.create',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
  });

  it('sends the verification email AFTER the commit, never inside the transaction', async () => {
    // Carry-forward ruling 44, and the pattern Tasks 10, 11 and 15 copy. Task 5
    // could only write this as a docblock because no endpoint existed; this is
    // the endpoint.
    const { service, db, mail } = harness();
    await service.register(COMMAND);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.templateId).toBe('emailVerification');
    expect(names(db).at(-1)).toBe('$transaction:commit');
  });

  it('sends NOTHING when the transaction fails after the writes', async () => {
    // The half of ruling 44 that a passing happy path cannot show. Every
    // statement inside the transaction succeeded and the commit failed, so a
    // send placed one line earlier would already have gone out — telling
    // somebody their account was created when it was not.
    const { service, db, mail } = harness();
    db.control.failTransaction = new Error('commit refused');

    await expect(service.register(COMMAND)).rejects.toThrow('commit refused');
    expect(mail.sent).toEqual([]);
  });

  it('puts no raw token, password or address in the audit event', async () => {
    // Critical security rule 5 and 6, and `TokenService`'s own promise that the
    // raw value never enters an audit event's metadata.
    const { service, db } = harness();
    await service.register(COMMAND);

    const event = db.calls.find((call) => call.name === 'tx.platformAuditEvent.create')?.args as
      { metadata?: Record<string, unknown> } | undefined;
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(COMMAND.password);
    expect(serialised).not.toContain(COMMAND.email);
    for (const hash of db.issuedTokenHashes) expect(serialised).not.toContain(hash);
    // THE EXACT KEY SET, not a substring search, and this is a finding from
    // mutation testing rather than a stylistic preference. A mutant that put
    // the RAW token in `metadata` survived the three assertions above — the
    // fake never sees the raw value, only its hash, so there was nothing to
    // search for. An allowlist of keys does not depend on knowing what the
    // forbidden value looks like, which is the only version of this assertion
    // that holds for a secret the spec cannot see.
    expect(Object.keys(event?.metadata ?? {}).sort()).toEqual(['hasName', 'verificationTokenId']);
    expect(event).toMatchObject({
      actorType: 'USER',
      action: 'USER_REGISTERED',
      resourceType: 'User',
      ip: '203.0.113.7',
      requestId: COMMAND.requestId,
    });
  });
});

describe('an address that already exists', () => {
  function existing(overrides: Partial<{ emailVerifiedAt: Date | null; status: string }> = {}) {
    const { service, db, mail, passwords, breached } = harness();
    const row = {
      id: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
      email: COMMAND.email,
      name: 'Grace Hopper',
      emailVerifiedAt: null,
      status: 'ACTIVE',
      ...overrides,
    };
    db.users.set(row.email, row);
    db.users.set(row.id, row);
    return { service, db, mail, passwords, breached, row };
  }

  it('creates nothing and changes nothing about the account', async () => {
    const { service, db } = existing();
    await service.register(COMMAND);

    expect(names(db)).not.toContain('tx.user.create');
    expect(names(db)).not.toContain('tx.user.update');
    expect(names(db)).not.toContain('tx.credential.create');
    expect(names(db)).not.toContain('tx.verificationToken.create');
  });

  it('sends the registration-attempt notice instead of a verification link', async () => {
    // Ruling B. The difference between the two paths is in a mailbox and never
    // on the wire.
    const { service, mail, row } = existing();
    await service.register(COMMAND);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.templateId).toBe('registrationAttempt');
    expect(mail.sent[0]?.to).toBe(row.email);
    // No link and no token: the notice rules, restated at the send rather than
    // trusted from the template's own spec.
    expect(mail.sent[0]?.text).not.toMatch(/https?:\/\//);
    expect(mail.sent[0]?.html).not.toContain('href');
  });

  it('pays for the Argon2id hash anyway', async () => {
    // THE TIMING HALF OF ENUMERATION RESISTANCE, and the mirror of
    // carry-forward ruling 21. On login the ABSENT account is the one that
    // would skip the work; here it is the EXISTING one. Asserted as "the work
    // happened" rather than as a wall-clock comparison: a statistical timing
    // assertion over a fake database measures scheduling, not behaviour
    // (carry-forward ruling 49). The measured figures are in the task report.
    const { service, passwords } = existing();
    const hash = vi.spyOn(passwords, 'hash');

    await service.register(COMMAND);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('does not compare the submitted password against the stored credential', async () => {
    // A registration form is not a login form. Treating a matching password as
    // "the same person" would make this a credential check with no failed-login
    // accounting and no lockout behind it.
    const { service, passwords } = existing();
    const verify = vi.spyOn(passwords, 'verify');

    await service.register(COMMAND);
    expect(verify).not.toHaveBeenCalled();
  });

  it('records the blocked attempt with no actor and the existing account as the resource', async () => {
    const { service, db, row } = existing();
    await service.register(COMMAND);

    const event = db.calls.find((call) => call.name === 'tx.platformAuditEvent.create')?.args;
    expect(event).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      action: 'REGISTRATION_BLOCKED_EXISTING_EMAIL',
      resourceId: row.id,
    });
    expect(JSON.stringify(event)).not.toContain(COMMAND.email);
  });

  it('behaves the same way for an account that is already verified', async () => {
    const { service, mail } = existing({ emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z') });
    await service.register(COMMAND);
    expect(mail.sent[0]?.templateId).toBe('registrationAttempt');
  });

  it('behaves the same way for a LOCKED account', async () => {
    // The response and the mailbox must not distinguish an account's status
    // either. `UserStatus` is ACTIVE | LOCKED | DISABLED; there is no SUSPENDED.
    const { service, mail } = existing({ status: 'LOCKED' });
    await service.register(COMMAND);
    expect(mail.sent[0]?.templateId).toBe('registrationAttempt');
  });
});

describe('two requests registering the same new address at once', () => {
  it('turns the loser P2002 into the existing-address path rather than a 500', async () => {
    // The lookup returned null for both callers and `User.email` is @unique, so
    // one of them gets P2002 AFTER the branch was chosen. Letting it out would
    // be a 500 for one caller and a 200 for the other on identical input — an
    // existence oracle that needs one extra request to open.
    const { service, db, mail } = harness();
    const winner = {
      id: 'usr_01M0T74WZZFY9T2QS56RGF3GQ8',
      email: COMMAND.email,
      name: null,
      emailVerifiedAt: null,
      status: 'ACTIVE',
    };
    // Shaped like Prisma's own `PrismaClientKnownRequestError`: an `Error` that
    // carries `code` as a property. A plain object would be a fixture the real
    // client never produces, and `isUniqueConstraintViolation` would then be
    // tested against something it will never see.
    db.control.failUserCreate = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });
    // The winner's row is visible by the time the loser looks again.
    db.users.set(winner.email, winner);
    db.users.set(winner.id, winner);

    await expect(service.register(COMMAND)).resolves.toBeUndefined();
    expect(mail.sent[0]?.templateId).toBe('registrationAttempt');
  });

  it('does not swallow an error that is not a unique-constraint violation', async () => {
    // The narrow catch is the point. A fake that returned success for every
    // failure would make this endpoint report success for a database outage.
    const { service, db } = harness();
    db.control.failUserCreate = new Error('connection reset');

    await expect(service.register(COMMAND)).rejects.toThrow('connection reset');
  });
});

describe('the breach check', () => {
  it('refuses a breached password before any database work, on either path', async () => {
    const { service, db, breached, mail } = harness();
    breached.value = true;

    await expect(service.register(COMMAND)).rejects.toBeInstanceOf(PasswordBreachedError);
    expect(names(db)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });
});

describe('a failed send', () => {
  it('does not reach the caller, on either path', async () => {
    // A propagated send failure would be observable on both paths — but only
    // for an address whose message the relay happened to reject, which is a
    // difference an attacker can provoke. See `auth-mailer.ts`.
    const { service, mail } = harness();
    mail.control.failWith = new Error('550 mailbox unavailable');

    await expect(service.register(COMMAND)).resolves.toBeUndefined();
  });
});
