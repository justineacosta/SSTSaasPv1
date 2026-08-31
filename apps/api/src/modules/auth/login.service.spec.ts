import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '@sentinel/observability';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import {
  identityStoreFake,
  type IdentityStoreFake,
  identityUserRow,
  mailerFake,
  type MailerFake,
} from '../../testing/identity-fakes.js';
import type { IdentityUserRow } from './identity.store.js';
import { AccountLockedError } from './account-locked.error.js';
import { InvalidCredentialsError } from './invalid-credentials.error.js';
import { LOCKOUT_LADDER_SECONDS } from './lockout.js';
import { LoginService, type SessionIssuer } from './login.service.js';
import { PasswordService } from './password.service.js';
import type { IssuedSession, IssueSessionInput } from './session.service.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';
import type { ApiEnv } from '@sentinel/config';

/**
 * LOGIN'S BRANCHING AND ORDERING, WHERE A DATABASE CANNOT SHOW THEM.
 *
 * The same division `registration.service.spec.ts` draws: what needs real
 * Postgres — the counter surviving a restart, the audit row's append-only
 * trigger, the byte-identical enumeration comparison — is in the integration
 * lane. What is asserted here is the sequence a real database hides: that the
 * Argon2id verification happens on BOTH paths, that the absent account is the
 * one passed `null`, that mail leaves after the commit and never inside it, and
 * that an attempt during a live lock writes nothing at all.
 *
 * **Every instant in this file is pinned.** Carry-forward ruling 49: an
 * assertion between two values both derived from `Date.now()` in the same test
 * is an assertion about scheduling. `LoginService` takes no clock, so the
 * assertions below are about the ladder's *shape* — the delta between the lock
 * it wrote and the moment the test started — with a generous tolerance in the
 * one place a real clock reading is unavoidable, and exact equality everywhere
 * else via `lockout.spec.ts`, which owns the arithmetic.
 */

/** Reduced Argon2 parameters. The property under test is never the cost. */
const ARGON2 = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';

const COMMAND = {
  email: 'ada@example.test',
  password: PASSWORD,
  rememberMe: false,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger({ service: 'api', level: 'debug', pretty: false, stream }), lines };
}

/**
 * A recording `SessionIssuer`.
 *
 * `LoginService` takes the narrow port rather than `SessionService` itself, the
 * same way `AuthenticationGuard` takes `SessionResolver` — a service typed
 * against the whole session machine is a service whose every spec is either a
 * mock of the world or an integration test. What the real `issue` does with the
 * input is `session.service.spec.ts`'s and the integration lane's; what is
 * asserted here is what login ASKS FOR, which is the part login decides.
 */
function issuerFake(): { issuer: SessionIssuer; issued: IssueSessionInput[] } {
  const issued: IssueSessionInput[] = [];
  return {
    issued,
    issuer: {
      issue: (input): Promise<IssuedSession> => {
        issued.push(input);
        return Promise.resolve({
          session: {
            id: 'ses_01M0T74WZZFY9T2QS56RGF3GQ7',
            userId: String(input.userId),
            status: input.status,
            activeOrganizationId: null,
            rememberMe: input.rememberMe === true,
            absoluteExpiresAt: new Date('2026-09-07T12:00:00.000Z'),
            idleExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
            lastSeenAt: new Date('2026-08-31T12:00:00.000Z'),
            mfaCompletedAt: null,
          },
          token: 'FIXTURE_not_a_real_token-login_000000000000',
          cookieMaxAgeSeconds: input.rememberMe === true ? 2_592_000 : null,
        });
      },
    },
  };
}

interface Harness {
  readonly service: LoginService;
  readonly db: IdentityStoreFake;
  readonly mail: MailerFake;
  readonly passwords: PasswordService;
  readonly issued: IssueSessionInput[];
  readonly lines: string[];
}

function harness(): Harness {
  const db = identityStoreFake();
  const mail = mailerFake();
  const passwords = new PasswordService(ARGON2);
  const tokens = new TokenService(db.tokenStore, TTL);
  const { logger, lines } = captureLogger();
  const { issuer, issued } = issuerFake();

  const mailer = new AuthMailer(mail.mailer, ENV, tokens, logger);
  const service = new LoginService(
    db.store,
    passwords,
    issuer,
    new PlatformAuditService(),
    mailer,
    logger,
  );
  return { service, db, mail, passwords, issued, lines };
}

const names = (db: IdentityStoreFake): string[] => db.calls.map((call) => call.name);

const auditEvents = (db: IdentityStoreFake): Record<string, unknown>[] =>
  db.calls
    .filter((call) => call.name === 'tx.platformAuditEvent.create')
    .map((call) => call.args as Record<string, unknown>);

const actions = (db: IdentityStoreFake): unknown[] =>
  auditEvents(db).map((event) => event['action']);

const userUpdates = (db: IdentityStoreFake): Record<string, unknown>[] =>
  db.calls
    .filter((call) => call.name === 'tx.user.update')
    .map((call) => (call.args as { data: Record<string, unknown> }).data);

/**
 * The account row as it stands AFTER the call, read out of the fake.
 *
 * Since H1 the failure path no longer writes the counter as an absolute value
 * it computed — Postgres computes it, from `{ increment: 1 }` under the row
 * lock — so there is no update payload carrying it to assert against. These
 * assertions read the end state instead, which is what the ladder is actually
 * about and is a stronger statement than the payload ever was: it holds for
 * whatever statement shape produces it.
 */
const storedUser = (db: IdentityStoreFake): IdentityUserRow => {
  const row = db.users.get(COMMAND.email);
  if (row === undefined) throw new Error('no account seeded');
  return row;
};

/** Seeds an account with a real Argon2id hash of `PASSWORD`. */
async function seedAccount(
  h: Harness,
  overrides: Parameters<typeof identityUserRow>[0] = {},
): Promise<{ id: string; email: string }> {
  const row = identityUserRow({ email: COMMAND.email, emailVerifiedAt: new Date(), ...overrides });
  h.db.users.set(row.email, row);
  h.db.users.set(row.id, row);
  h.db.credentials.set(row.id, await h.passwords.hash(PASSWORD));
  return { id: row.id, email: row.email };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('both paths pay for the Argon2id verification', () => {
  it('verifies against the STORED hash when the account exists', async () => {
    const h = harness();
    const account = await seedAccount(h);
    const stored = h.db.credentials.get(account.id);
    const verify = vi.spyOn(h.passwords, 'verify');

    await h.service.login(COMMAND);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBe(stored);
  });

  it('verifies against NULL when the address has no account', async () => {
    // CARRY-FORWARD RULING 21, AND THE ASSERTION THE BRIEF ASKS FOR BY NAME.
    // `PasswordService.verify(null, ...)` runs a full Argon2id verification
    // against the dummy; the absent account must not be the cheap path, because
    // the difference in cost is the whole enumeration oracle. A mutation that
    // returns early for `user === null` turns this red — and it was run: see
    // the task report.
    const h = harness();
    const verify = vi.spyOn(h.passwords, 'verify');

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toBeNull();
  });

  it('verifies against NULL for an account whose credential row is missing', async () => {
    // A real state: `Credential` is a separate table and a `User` can exist
    // without one. The same nullable-hash path covers it, so it costs the same
    // as an absent account rather than skipping the work.
    const h = harness();
    const row = identityUserRow({ email: COMMAND.email });
    h.db.users.set(row.email, row);
    h.db.users.set(row.id, row);
    const verify = vi.spyOn(h.passwords, 'verify');

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(verify.mock.calls[0]?.[0]).toBeNull();
  });

  it('does not read the credential table at all when there is no user', async () => {
    // The cost difference that DOES remain, stated rather than hidden: an
    // absent account skips one indexed lookup on `Credential`. It is dominated
    // by the Argon2id verification both paths pay, which is the same trade
    // `registration.service.ts` records and measures. Asserted so a reader can
    // see what the residual actually is.
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(names(h.db)).not.toContain('credential.findUnique');
  });
});

describe('an attempt against an address with no account', () => {
  it('refuses with INVALID_CREDENTIALS and writes one LOGIN_FAILED row naming nothing', async () => {
    // D5. `security/audit.md` §3 says failures and denials are audited, and
    // this is the row Task 8 could not write: registration's refusal rolls its
    // transaction back, and a login failure does not, because it commits.
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(actions(h.db)).toEqual(['LOGIN_FAILED']);
    expect(auditEvents(h.db)[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      resourceType: 'User',
      resourceId: null,
      ip: COMMAND.ip,
      requestId: COMMAND.requestId,
    });
  });

  it('does not put the attempted address anywhere in the row', async () => {
    // D5, and the rate limiter's own precedent — it hashes the address before
    // it becomes a Redis key. The forensic signal that matters is "this IP
    // failed against N unknown addresses", which `ip` and `requestId` already
    // carry. The address belongs to somebody who is not a customer, and an
    // append-only table is the worst place to learn that.
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(JSON.stringify(auditEvents(h.db))).not.toContain(COMMAND.email);
  });

  it('writes no user row and issues no session', async () => {
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(names(h.db)).not.toContain('tx.user.update');
    expect(h.issued).toEqual([]);
  });

  it('sends no mail — there is nobody to notify', async () => {
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(h.mail.sent).toEqual([]);
  });
});

describe('a wrong password on an existing account', () => {
  it('refuses with INVALID_CREDENTIALS and increments the counter', async () => {
    const h = harness();
    const account = await seedAccount(h);

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(storedUser(h.db).failedLoginCount).toBe(1);
    expect(storedUser(h.db).lockedUntil).toBeNull();
    expect(actions(h.db)).toEqual(['LOGIN_FAILED']);
    expect(auditEvents(h.db)[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      resourceId: account.id,
    });
  });

  it('writes the increment and the audit row in ONE transaction', async () => {
    // `CLAUDE.md` rule 10 and `security/audit.md` §2. Asserted as a sequence
    // rather than as two calls that each happened, because two calls that each
    // happened is not evidence they happened together.
    const h = harness();
    await seedAccount(h);

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const sequence = names(h.db).slice(names(h.db).indexOf('$transaction:begin'));
    expect(sequence).toEqual([
      '$transaction:begin',
      // The atomic increment FIRST, so the row lock it takes covers everything
      // after it. H1: the count used below is the one Postgres produced, not
      // one the application carried across a 40 ms hash.
      'tx.user.updateMany',
      'tx.user.findUnique',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
  });

  it('puts no password and no address in the audit row', async () => {
    const h = harness();
    await seedAccount(h);

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const serialised = JSON.stringify(auditEvents(h.db));
    expect(serialised).not.toContain(WRONG);
    expect(serialised).not.toContain(COMMAND.email);
    // THE EXACT KEY SET, not a substring search — `registration.service.spec.ts`
    // records why: a mutant that put the raw password in `metadata` survives a
    // substring search whenever the spec cannot see the value it is looking for.
    expect(Object.keys(auditEvents(h.db)[0]?.['metadata'] ?? {}).sort()).toEqual([
      'consecutiveFailures',
      'knownAccount',
    ]);
  });

  it('issues no session and sets no cookie material', async () => {
    const h = harness();
    await seedAccount(h);
    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(h.issued).toEqual([]);
  });
});

describe('the lockout ladder', () => {
  const startedAt = (): number => Date.now();

  /** The lock a failure at `existingCount + 1` should produce, as a delta. */
  async function failAt(existingCount: number): Promise<{ h: Harness; before: number }> {
    const h = harness();
    await seedAccount(h, { failedLoginCount: existingCount });
    const before = startedAt();
    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    return { h, before };
  }

  it('does not lock on the first four failures', async () => {
    for (const existing of [0, 1, 2, 3]) {
      const { h } = await failAt(existing);
      const row = storedUser(h.db);
      expect(row.failedLoginCount, `after ${String(existing + 1)} failures`).toBe(existing + 1);
      expect(row.lockedUntil, `after ${String(existing + 1)} failures`).toBeNull();
      expect(actions(h.db)).toEqual(['LOGIN_FAILED']);
    }
  });

  it('locks on the fifth, sixth, seventh and eighth with the ladder lockout.ts defines', async () => {
    const rungs: [number, number][] = [
      [4, LOCKOUT_LADDER_SECONDS[0]],
      [5, LOCKOUT_LADDER_SECONDS[1]],
      [6, LOCKOUT_LADDER_SECONDS[2]],
      [7, LOCKOUT_LADDER_SECONDS[3]],
    ];

    for (const [existing, seconds] of rungs) {
      const { h, before } = await failAt(existing);
      const row = storedUser(h.db);
      expect(row.failedLoginCount).toBe(existing + 1);
      const until = row.lockedUntil;
      expect(until).toBeInstanceOf(Date);
      // The delta, not two clock readings compared to each other: ruling 49.
      // `before` is taken immediately before the call, so the window here is
      // the elapsed test time — a mutant that used a different rung is off by
      // at least 4 minutes and cannot hide inside it.
      const delta = (until as Date).getTime() - before;
      expect(delta, `rung for ${String(existing + 1)} failures`).toBeGreaterThanOrEqual(
        seconds * 1000 - 5_000,
      );
      expect(delta).toBeLessThanOrEqual(seconds * 1000 + 5_000);
    }
  });

  it('caps the ladder — a hundredth failure locks for the same thirty minutes as the eighth', async () => {
    const { h, before } = await failAt(99);
    const until = storedUser(h.db).lockedUntil;
    if (until === null) throw new Error('expected a lock');
    const delta = until.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(LOCKOUT_LADDER_SECONDS[3] * 1000 - 5_000);
    expect(delta).toBeLessThanOrEqual(LOCKOUT_LADDER_SECONDS[3] * 1000 + 5_000);
  });

  it('writes ACCOUNT_LOCKED beside LOGIN_FAILED on the attempt that trips it', async () => {
    const { h } = await failAt(4);
    expect(actions(h.db)).toEqual(['LOGIN_FAILED', 'ACCOUNT_LOCKED']);
    // Both in the same transaction as the increment they describe.
    const sequence = names(h.db).slice(names(h.db).indexOf('$transaction:begin'));
    expect(sequence).toEqual([
      '$transaction:begin',
      'tx.user.updateMany',
      'tx.user.findUnique',
      // The lock, written on its own and only when the count the database just
      // produced earns one. It does not restate the counter: restating a value
      // the database chose is the H1 defect.
      'tx.user.update',
      'tx.platformAuditEvent.create',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
    // The lock statement carries the lock and NOTHING else — the exact key
    // set, because restating the counter the database just chose is the H1
    // defect and a `toMatchObject` would not see it come back.
    const written = userUpdates(h.db);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0] ?? {})).toEqual(['lockedUntil']);
    expect(written[0]?.['lockedUntil']).toBeInstanceOf(Date);
  });

  it('writes no ACCOUNT_LOCKED row on a failure that does not trip a lock', async () => {
    const { h } = await failAt(2);
    expect(actions(h.db)).toEqual(['LOGIN_FAILED']);
  });
});

describe('an attempt while the lock is live', () => {
  const LOCKED_UNTIL = new Date(Date.now() + 10 * 60 * 1000);

  it('changes NO state on a wrong password, and refuses with INVALID_CREDENTIALS', async () => {
    // D2, and it is the half that stops the lock becoming the attack. If an
    // attempt during a live lock extended the lock, an attacker who wants an
    // account offline keeps it there forever by attempting once a minute —
    // §7's "one attacker must not lock out a whole tenant" one level down, with
    // the tenant replaced by a person.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 5, lockedUntil: LOCKED_UNTIL });

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(names(h.db)).not.toContain('tx.user.updateMany');
    expect(names(h.db)).not.toContain('tx.user.update');
    expect(names(h.db)).not.toContain('$transaction:begin');
    expect(h.mail.sent).toEqual([]);
  });

  it('answers ACCOUNT_LOCKED when the password is CORRECT, and still changes no state', async () => {
    // D3. The real user needs to be told why their correct password is not
    // working, and it tells an attacker nothing they did not already have —
    // they would need the password to see it.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 5, lockedUntil: LOCKED_UNTIL });

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);

    expect(names(h.db)).not.toContain('tx.user.update');
    expect(h.issued).toEqual([]);
    expect(h.mail.sent).toEqual([]);
  });

  it('still verifies the password, so the two arms cost the same', async () => {
    // The lock is consulted AFTER the verification, never before. Checking it
    // first would make a locked account answer measurably faster than an
    // unlocked one, which is an oracle for "this address is registered AND
    // somebody has been guessing at it".
    const h = harness();
    await seedAccount(h, { failedLoginCount: 5, lockedUntil: LOCKED_UNTIL });
    const verify = vi.spyOn(h.passwords, 'verify');

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('resumes climbing once the lock has expired, because the counter was never reset', async () => {
    // The ladder is not per-cycle. Only a SUCCESSFUL login resets the counter,
    // so an attacker who waits out a one-minute lock meets a five-minute one.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 5, lockedUntil: new Date(Date.now() - 1_000) });
    const before = Date.now();

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    const row = storedUser(h.db);
    expect(row.failedLoginCount).toBe(6);
    if (row.lockedUntil === null) throw new Error('expected a lock');
    const delta = row.lockedUntil.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(LOCKOUT_LADDER_SECONDS[1] * 1000 - 5_000);
  });
});

describe('the burst notice', () => {
  it('is sent on the attempt that trips the lock', async () => {
    const h = harness();
    await seedAccount(h, { failedLoginCount: 4 });

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(h.mail.sent.map((mail) => mail.templateId)).toEqual(['failedLoginBurst']);
    expect(h.mail.sent[0]?.to).toBe(COMMAND.email);
  });

  it('is NOT sent on the failures below the threshold', async () => {
    for (const existing of [0, 1, 2, 3]) {
      const h = harness();
      await seedAccount(h, { failedLoginCount: existing });
      await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      expect(h.mail.sent, `after ${String(existing + 1)} failures`).toEqual([]);
    }
  });

  it('is sent ONCE PER LOCK, not once per failure past the threshold', async () => {
    // D6. Every attempt after the fifth arrives while the lock is live, and an
    // attempt during a live lock changes no state and sends nothing — so the
    // notice cannot repeat within one cycle. Asserted rather than argued,
    // because "sent once" resting on a property of a different method is
    // exactly the kind of claim that stops being true when that method changes.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 4 });

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(h.mail.sent).toHaveLength(1);

    // The account is now locked; the fake's row still says so.
    const row = h.db.users.get(COMMAND.email);
    const locked = identityUserRow({
      ...row,
      failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    h.db.users.set(locked.email, locked);
    h.db.users.set(locked.id, locked);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    }
    expect(h.mail.sent).toHaveLength(1);
  });

  it('renders no IP, no user agent and no display name', async () => {
    // Rulings 63 and 70 at the send rather than only in the template's own
    // spec. The burst is somebody else's session: none of the three describes
    // the recipient, and the user agent is a header that party chose.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 4, name: 'Ada <script>alert(1)</script> Lovelace' });

    await expect(
      h.service.login({ ...COMMAND, password: WRONG, userAgent: 'FIXTURE-agent-Chameleon/1.0' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    const sent = h.mail.sent[0];
    for (const part of [sent?.text ?? '', sent?.html ?? '']) {
      expect(part).not.toContain('FIXTURE-agent-Chameleon/1.0');
      expect(part).not.toContain(COMMAND.ip);
      expect(part).not.toContain('Ada');
      expect(part).not.toContain('script');
    }
  });

  it('leaves the notice AFTER the commit, and sends nothing when the commit fails', async () => {
    // Carry-forward ruling 44, and the half a passing happy path cannot show:
    // every statement inside the transaction succeeded and the commit failed,
    // so a send placed one line earlier would already have told somebody their
    // account was locked when it was not.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 4 });
    h.db.control.failTransaction = new Error('commit refused');

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toThrow(
      'commit refused',
    );
    expect(h.mail.sent).toEqual([]);
  });

  it('does not let a failed send change the refusal', async () => {
    // Carry-forward ruling 45 and `AuthMailer`'s own contract. A propagated
    // send failure would turn a mail-transport outcome into a different HTTP
    // response for a locked account than for any other failure.
    const h = harness();
    await seedAccount(h, { failedLoginCount: 4 });
    h.mail.control.failWith = new Error('550 mailbox unavailable');

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe('a successful login', () => {
  it('resets the counter, clears the lock and stamps lastLoginAt in one statement', async () => {
    const h = harness();
    await seedAccount(h, { failedLoginCount: 3 });

    await h.service.login(COMMAND);

    const update = userUpdates(h.db)[0];
    expect(update?.['failedLoginCount']).toBe(0);
    expect(update?.['lockedUntil']).toBeNull();
    expect(update?.['lastLoginAt']).toBeInstanceOf(Date);
  });

  it('writes one LOGIN row naming the user as the actor', async () => {
    // The one row in this task whose actor really is the account owner: they
    // just proved they hold the password.
    const h = harness();
    const account = await seedAccount(h);

    await h.service.login(COMMAND);

    expect(actions(h.db)).toEqual(['LOGIN']);
    expect(auditEvents(h.db)[0]).toMatchObject({
      actorType: 'USER',
      actorId: account.id,
      resourceType: 'User',
      resourceId: account.id,
    });
  });

  it('issues an ACTIVE session, stating the status explicitly', async () => {
    // Carry-forward ruling 6: `Session.status` has no `@default`, and
    // `issueSessionInputSchema` has none either, so forgetting it is a compile
    // error rather than a silently privileged session. Asserted at the call
    // site too, because "the schema would have caught it" is a claim about a
    // different file.
    const h = harness();
    const account = await seedAccount(h);

    const result = await h.service.login(COMMAND);

    expect(result).toEqual({
      kind: 'authenticated',
      token: 'FIXTURE_not_a_real_token-login_000000000000',
      cookieMaxAgeSeconds: null,
    });
    expect(h.issued).toEqual([
      {
        userId: account.id,
        status: 'ACTIVE',
        rememberMe: false,
        mfaCompletedAt: null,
        ip: COMMAND.ip,
        userAgent: COMMAND.userAgent,
      },
    ]);
  });

  it('passes rememberMe through to the session issuer', async () => {
    // D10. The 7-day / 30-day split and the browser-session cookie are
    // `SessionService.issue`'s and are tested there; what login owns is passing
    // the flag rather than dropping it.
    const h = harness();
    await seedAccount(h);

    const result = await h.service.login({ ...COMMAND, rememberMe: true });

    expect(h.issued[0]?.rememberMe).toBe(true);
    expect(result).toMatchObject({ cookieMaxAgeSeconds: 2_592_000 });
  });

  it('issues the session AFTER the transaction commits', async () => {
    // The credential must not exist before the row that says the login
    // happened. A session minted inside the transaction survives in Redis and
    // in the caller's hand even when the transaction rolls back.
    const h = harness();
    await seedAccount(h);
    h.db.control.failTransaction = new Error('commit refused');

    await expect(h.service.login(COMMAND)).rejects.toThrow('commit refused');
    expect(h.issued).toEqual([]);
  });
});

describe('the new-device notice', () => {
  it('is sent when no previous session carried this IP and user agent', async () => {
    const h = harness();
    await seedAccount(h);

    await h.service.login(COMMAND);

    expect(h.mail.sent.map((mail) => mail.templateId)).toEqual(['newDeviceSignIn']);
    expect(h.mail.sent[0]?.to).toBe(COMMAND.email);
  });

  it('is NOT sent when a previous session carried the same pair', async () => {
    const h = harness();
    const account = await seedAccount(h);
    h.db.priorSessions.push({
      userId: account.id,
      ip: COMMAND.ip,
      userAgent: COMMAND.userAgent,
    });

    await h.service.login(COMMAND);
    expect(h.mail.sent).toEqual([]);
  });

  it('asks the familiarity question BEFORE the session is issued', async () => {
    // Otherwise the session just minted is the match, every login is familiar,
    // and the notice never fires again. The ordering is the whole mechanism.
    const h = harness();
    await seedAccount(h);

    await h.service.login(COMMAND);

    expect(names(h.db)).toContain('session.findFirst');
    expect(names(h.db).indexOf('session.findFirst')).toBeLessThan(
      names(h.db).indexOf('$transaction:begin'),
    );
  });

  it('is NOT sent to an address whose ownership has not been proven', async () => {
    // Ruling 70's rule at the caller. The template carries no display name, so
    // there is nothing to inject — but a branded security notice to an
    // unverified address is still a message this product sends to somebody who
    // may not be the account owner, and the account owner is who it is for.
    const h = harness();
    await seedAccount(h, { emailVerifiedAt: null });

    await h.service.login(COMMAND);
    expect(h.mail.sent).toEqual([]);
  });

  it('renders no display name, even a hostile one', async () => {
    const h = harness();
    await seedAccount(h, { name: 'Ada https://evil.example/?token=x Lovelace' });

    await h.service.login(COMMAND);

    const sent = h.mail.sent[0];
    for (const part of [sent?.text ?? '', sent?.html ?? '']) {
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('Ada');
    }
  });

  it('renders NO USER AGENT, even one that is a sentence and a link — H2', async () => {
    // THE FINDING, AT THE CALLER, THROUGH THE REAL MAILER AND THE REAL TEMPLATE.
    //
    // This notice fires on an *unfamiliar* sign-in, so on the takeover path the
    // party who chose the `User-Agent` and the person reading the message are
    // different people. The reviewer rendered the pre-fix output from the built
    // module: `Device: Mozilla/5.0 -- SECURITY ALERT: confirm your account now
    // at https://sentinel-verify.evil.example/login`, under a footer promising
    // the message contains no link.
    //
    // `registry.spec.ts` holds the template side; this holds the side that
    // matters for regression — that the SERVICE does not find some other way to
    // put the header in front of the recipient. `AuthMailer.sendNewDeviceSignIn`
    // has no parameter for it, so this cannot fail while `pnpm typecheck`
    // passes; it is here because the caller is what changed the risk.
    const h = harness();
    await seedAccount(h);

    await h.service.login({
      ...COMMAND,
      userAgent:
        'Mozilla/5.0 -- SECURITY ALERT: confirm your account at https://sentinel-verify.evil.example/login',
    });

    const sent = h.mail.sent[0];
    expect(sent?.templateId).toBe('newDeviceSignIn');
    for (const part of [sent?.text ?? '', sent?.html ?? '']) {
      expect(part).not.toContain('sentinel-verify.evil.example');
      expect(part).not.toContain('SECURITY ALERT');
      expect(part).not.toContain('Device:');
      // The footer's promise, checked against the message that carries it.
      expect(part).not.toMatch(/https?:\/\//);
    }
  });

  it('still names the IP address, which is the one line the recipient can act on', async () => {
    // The other side of H2's disposition: the user agent goes and the address
    // stays. Two-sided so the fix cannot drift into removing the whole block —
    // that would cost the recipient the only fact in the message they can check.
    const h = harness();
    await seedAccount(h);

    await h.service.login(COMMAND);

    expect(h.mail.sent[0]?.text).toContain(COMMAND.ip);
  });

  it('leaves after the commit, and not at all when the commit fails', async () => {
    const h = harness();
    await seedAccount(h);
    h.db.control.failTransaction = new Error('commit refused');

    await expect(h.service.login(COMMAND)).rejects.toThrow('commit refused');
    expect(h.mail.sent).toEqual([]);
  });
});

describe('an account with a confirmed MFA factor', () => {
  it('issues a PENDING_MFA session and returns the pending token with no cookie', async () => {
    // D9. No account can hold a confirmed factor until Task 11 ships enrolment,
    // and login must refuse to issue an ACTIVE session when one exists anyway —
    // otherwise Task 11 lands on top of a latent MFA bypass.
    const h = harness();
    const account = await seedAccount(h);
    h.db.confirmedMfaUserIds.add(account.id);

    const result = await h.service.login(COMMAND);

    expect(result).toEqual({
      kind: 'mfa-required',
      pendingToken: 'FIXTURE_not_a_real_token-login_000000000000',
    });
    expect(h.issued[0]).toMatchObject({ status: 'PENDING_MFA', mfaCompletedAt: null });
  });

  it('ignores rememberMe on the pending session', async () => {
    // `absoluteLifetimeSeconds` already ignores it for a `PENDING_MFA` session,
    // and this asserts login does not work around that by some other route: a
    // pending session is a few minutes of permission to type six digits, not a
    // session the user asked to be remembered.
    const h = harness();
    const account = await seedAccount(h);
    h.db.confirmedMfaUserIds.add(account.id);

    const result = await h.service.login({ ...COMMAND, rememberMe: true });
    expect(result).toEqual({
      kind: 'mfa-required',
      pendingToken: 'FIXTURE_not_a_real_token-login_000000000000',
    });
  });

  it('does not send the new-device notice for a login that has not completed', async () => {
    // "New sign-in to your Sentinel account" would be a false statement about a
    // session that can do nothing but type a code. Task 11 owns the notice on
    // MFA completion; this is recorded in the service docblock as an open item
    // rather than left for someone to find as a missing email.
    const h = harness();
    const account = await seedAccount(h);
    h.db.confirmedMfaUserIds.add(account.id);

    await h.service.login(COMMAND);
    expect(h.mail.sent).toEqual([]);
  });

  it('still resets the counter, because the password WAS correct', async () => {
    const h = harness();
    const account = await seedAccount(h, { failedLoginCount: 3 });
    h.db.confirmedMfaUserIds.add(account.id);

    await h.service.login(COMMAND);

    // No `lastLoginAt`: nobody has logged in yet. The column means "the last
    // time a session that can do something was issued", and a pending session
    // is not one.
    expect(userUpdates(h.db)).toEqual([{ failedLoginCount: 0, lockedUntil: null }]);
  });

  it('does not consider an UNCONFIRMED factor', async () => {
    // Carry-forward ruling 7: an abandoned enrolment occupies the
    // `(userId, type)` unique slot, so the row exists. Gating a login on it
    // would lock a user out of their own account with a code nobody has.
    // The predicate is asserted rather than the outcome, because the fake
    // cannot hold an unconfirmed row — the delegate's `where` is what makes
    // this true.
    const h = harness();
    await seedAccount(h);

    await h.service.login(COMMAND);

    const call = h.db.calls.find((entry) => entry.name === 'mfaFactor.findFirst');
    expect(call?.args).toMatchObject({ confirmedAt: { not: null } });
  });
});

describe('a non-ACTIVE account', () => {
  it('answers ACCOUNT_LOCKED to a correct password on a LOCKED account', async () => {
    // `UserStatus.LOCKED` is the administrative lock, separate from
    // `lockedUntil` (`schema.prisma` says so on the model) — and the brief does
    // not mention it, so this is a decision recorded in the task report. The
    // shape follows D3 exactly: the real user, who has just proved they hold
    // the password, is told why it is not working; a wrong password gets the
    // same 401 as everything else.
    const h = harness();
    await seedAccount(h, { status: 'LOCKED' });

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);
    expect(h.issued).toEqual([]);
  });

  it('answers ACCOUNT_LOCKED to a correct password on a DISABLED account', async () => {
    const h = harness();
    await seedAccount(h, { status: 'DISABLED' });
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);
  });

  it('AUDITS the denial — M2 — naming the status that caused it', async () => {
    // `security/audit.md` §3 requires denials to be audited, and this is the
    // most investigation-relevant denial this endpoint can produce: somebody is
    // holding a WORKING credential for an account an operator deliberately
    // switched off. Before the fix round it produced a 403 and zero rows.
    //
    // The report's argument for writing nothing during a live brute-force lock
    // — that an unauthenticated caller must not be able to grow an append-only
    // table one row per request — does not reach this path. Reaching it
    // requires the correct password, and no `ACCOUNT_LOCKED` row exists for an
    // administrative status, so there is no other record that it happened.
    const h = harness();
    const account = await seedAccount(h, { status: 'DISABLED' });

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);

    expect(actions(h.db)).toEqual(['LOGIN_FAILED']);
    expect(auditEvents(h.db)[0]).toMatchObject({
      // SYSTEM with a null actor, like every other failure row. The password
      // was right, but an account an operator switched off is exactly the case
      // where "the credential holder is the account owner" is the assumption
      // worth not making in an append-only table.
      actorType: 'SYSTEM',
      actorId: null,
      resourceType: 'User',
      resourceId: account.id,
      ip: COMMAND.ip,
      requestId: COMMAND.requestId,
    });
    // THE EXACT KEY SET. `passwordAccepted` is the fact that makes this row
    // worth reading: it separates "somebody guessed at a disabled account" from
    // "somebody has its password".
    expect(Object.keys(auditEvents(h.db)[0]?.['metadata'] ?? {}).sort()).toEqual([
      'knownAccount',
      'passwordAccepted',
      'userStatus',
    ]);
    expect(auditEvents(h.db)[0]?.['metadata']).toMatchObject({
      userStatus: 'DISABLED',
      passwordAccepted: true,
    });
  });

  it('writes that row in a transaction carrying nothing else, and changes no state', async () => {
    // There is no state change to be atomic with — the counter is not touched,
    // because the password was correct and the refusal is about the account
    // rather than the attempt. The transaction is still opened, because
    // `PlatformAuditService.record` writes through a handle the caller passes
    // in and never opens its own.
    const h = harness();
    await seedAccount(h, { status: 'DISABLED' });

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);

    const sequence = names(h.db).slice(names(h.db).indexOf('$transaction:begin'));
    expect(sequence).toEqual([
      '$transaction:begin',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
    expect(names(h.db)).not.toContain('tx.user.updateMany');
    expect(names(h.db)).not.toContain('tx.user.update');
    expect(storedUser(h.db).failedLoginCount).toBe(0);
  });

  it('puts no password anywhere in that row', async () => {
    const h = harness();
    await seedAccount(h, { status: 'LOCKED' });
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(AccountLockedError);
    expect(JSON.stringify(auditEvents(h.db))).not.toContain(COMMAND.password);
    expect(JSON.stringify(auditEvents(h.db))).not.toContain(COMMAND.email);
  });

  it('answers INVALID_CREDENTIALS to a WRONG password on a LOCKED account, and counts it', async () => {
    const h = harness();
    await seedAccount(h, { status: 'LOCKED' });

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(storedUser(h.db).failedLoginCount).toBe(1);
    expect(storedUser(h.db).lockedUntil).toBeNull();
  });
});

describe('a stored credential argon2 cannot read', () => {
  it('logs at error with the user id, and answers INVALID_CREDENTIALS', async () => {
    // CARRY-FORWARD RULING 25, CLOSED. The caller learns nothing new; the
    // operator learns that a row is corrupt.
    const h = harness();
    const row = identityUserRow({ email: COMMAND.email });
    h.db.users.set(row.email, row);
    h.db.users.set(row.id, row);
    h.db.credentials.set(row.id, 'FIXTURE-not-a-phc-string');

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);

    const line = h.lines.find((entry) => entry.includes('credential'));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? '{}')).toMatchObject({ level: 'error', userId: row.id });
  });

  it('puts no fragment of the hash or the password in that line', async () => {
    // Critical security rule 6. The stored value is the thing that is broken,
    // and it is exactly the thing that must not be logged.
    const h = harness();
    const row = identityUserRow({ email: COMMAND.email });
    h.db.users.set(row.email, row);
    h.db.users.set(row.id, row);
    h.db.credentials.set(row.id, 'FIXTURE-not-a-phc-string');

    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);

    const captured = h.lines.join('\n');
    expect(captured).not.toContain('FIXTURE-not-a-phc-string');
    expect(captured).not.toContain(COMMAND.password);
  });

  it('logs nothing for an ordinary wrong password', async () => {
    // The anti-vacuity half. An `error` line on every failed login is an
    // operator alert that means nothing, and it would also make the log a
    // record of which addresses are registered.
    const h = harness();
    await seedAccount(h);

    await expect(h.service.login({ ...COMMAND, password: WRONG })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    expect(h.lines.filter((entry) => entry.includes('"level":"error"'))).toEqual([]);
  });

  it('logs nothing for an address with no account', async () => {
    // If it did, the log would answer "is this address registered?" — the
    // distinction the dummy-hash path exists to erase, moved into a file an
    // operator reads.
    const h = harness();
    await expect(h.service.login(COMMAND)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(h.lines.filter((entry) => entry.includes('"level":"error"'))).toEqual([]);
  });
});
