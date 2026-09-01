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
import { PasswordResetService } from './password-reset.service.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordService } from './password.service.js';
import { TokenInvalidError } from './token-invalid.error.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * WHAT THE FAKES CAN SHOW HERE, AND WHAT THEY DELIBERATELY DO NOT.
 *
 * The fake's `credential.updateMany` evaluates the compare-and-swap predicate
 * honestly against its own map — `count: 1` only if the stored hash is still
 * the one the caller verified against — so the REFUSING half of D3 is reachable
 * here. What it cannot model is two callers racing: there is no row lock and no
 * second request, and the property that matters is Postgres blocking the loser
 * and re-evaluating the predicate after the winner commits.
 * `auth.password.integration.spec.ts` owns that with a real `Promise.all`,
 * which is carry-forward ruling 74 — a test about two requests has to BE two
 * requests.
 *
 * Same division for token redemption: `control.redeemableUserId` fakes the
 * OUTCOME of a consume, never its single-use arbitration.
 *
 * What this file is for is the ordering and branching a database cannot show:
 * that the new hash is written and committed before anything is revoked (D2),
 * that a refusal rolls the redemption back rather than burning the link (D4),
 * that the breach check runs before the token is spent, and that the notice is
 * sent after the commit and never inside it.
 */

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

/**
 * Argon2 at the floor `@node-rs/argon2` accepts, for the reason
 * `password.timing.spec.ts` records: the properties under test here are
 * parameter-independent, so production parameters buy CI flake risk rather than
 * proof (carry-forward ruling 22).
 */
const ARGON2 = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

const CONTEXT = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

const NEW_PASSWORD = 'a brand new correct horse battery staple';

/**
 * The 35-character suffix of a password's SHA-1, which is what a k-anonymity
 * range response is keyed by. Computed rather than pasted, so the stub below
 * answers about the password the test actually submits.
 */
const suffixOf = (password: string): string =>
  createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase().slice(5);

const OLD_PASSWORD = 'the old password nobody should keep';

interface Harness {
  readonly service: PasswordResetService;
  readonly db: IdentityStoreFake;
  readonly mail: MailerFake;
  readonly passwords: PasswordService;
  readonly revoked: { userId: string; exceptSessionId: string | undefined }[];
}

function harness(options: { breached?: boolean } = {}): Harness {
  const db = identityStoreFake();
  const mail = mailerFake();
  const logger = createLogger({ service: 'test', level: 'fatal', pretty: false, silent: true });
  const tokens = new TokenService(db.tokenStore, TTL);
  const passwords = new PasswordService(ARGON2);
  const revoked: { userId: string; exceptSessionId: string | undefined }[] = [];
  const sessions = {
    revokeAllForUser: (userId: string, opts: { exceptSessionId?: string | undefined } = {}) => {
      // Recorded into the SAME list the store fake records into, so the
      // ordering assertions below compare one sequence rather than two clocks.
      db.calls.push({ name: 'sessions.revokeAllForUser', args: { userId } });
      revoked.push({ userId, exceptSessionId: opts.exceptSessionId });
      return Promise.resolve(revoked.length);
    },
  };
  // The real `BreachCheckService` with its transport stubbed, rather than a
  // stub of the service: ADR-0015's hermetic rule, and it keeps the real
  // fail-open behaviour instead of a spec-only approximation of it. The body is
  // a real range response naming the real suffix of the password under test —
  // a hard-coded line would make the "refuses a breached password" test pass
  // for the wrong reason, or not at all.
  const breachCheck = new BreachCheckService(
    { enabled: options.breached === true, rangeUrl: 'https://breach.invalid/range', timeoutMs: 50 },
    () => Promise.resolve({ status: 200, body: `${suffixOf(NEW_PASSWORD)}:42` }),
    logger,
  );
  const mailer = new AuthMailer(mail.mailer, ENV, tokens, logger);
  const service = new PasswordResetService(
    db.store,
    tokens,
    passwords,
    breachCheck,
    new PlatformAuditService(),
    mailer,
    sessions,
  );
  return { service, db, mail, passwords, revoked };
}

function withUser(
  db: IdentityStoreFake,
  overrides: Partial<{ emailVerifiedAt: Date | null; status: string; name: string | null }> = {},
) {
  const row = identityUserRow({ name: 'Ada Lovelace', ...overrides });
  db.users.set(row.email, row);
  db.users.set(row.id, row);
  return row;
}

const names = (db: IdentityStoreFake): string[] => db.calls.map((call) => call.name);

const auditRows = (db: IdentityStoreFake): Record<string, unknown>[] =>
  db.calls
    .filter((call) => call.name === 'tx.platformAuditEvent.create')
    .map((call) => call.args as Record<string, unknown>);

describe('forgot-password', () => {
  it('issues a token and sends the link for an active account', async () => {
    const { service, db, mail } = harness();
    const user = withUser(db, { emailVerifiedAt: new Date() });

    await service.request({ email: user.email, ...CONTEXT });

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['passwordReset']);
    expect(db.issuedTokenHashes).toHaveLength(1);
  });

  it('sends AFTER the transaction has committed, never inside it', async () => {
    // Carry-forward ruling 44. A send inside the transaction either holds it
    // open across network I/O to a third party, or mails a live link for a
    // token that then rolls back.
    const { service, db } = harness();
    const user = withUser(db);

    await service.request({ email: user.email, ...CONTEXT });

    const order = names(db);
    expect(order.indexOf('$transaction:commit')).toBeGreaterThan(
      order.indexOf('tx.verificationToken.create'),
    );
    expect(order.at(-1)).toBe('$transaction:commit');
  });

  it('sends nothing at all if the transaction fails at commit', async () => {
    const { service, db, mail } = harness();
    const user = withUser(db);
    db.control.failTransaction = new Error('commit failed');

    await expect(service.request({ email: user.email, ...CONTEXT })).rejects.toThrow(
      'commit failed',
    );
    expect(mail.sent).toEqual([]);
  });

  it('writes an audit row naming NOTHING for an address with no account', async () => {
    // D9 and `security/audit.md` §4. The wire response is identical for every
    // input by design, so this row is the only trace a distributed sweep
    // leaves — and the attempted address is deliberately not in it, because an
    // append-only table is the worst place to record the address of somebody
    // who is not a customer.
    const { service, db, mail } = harness();

    await service.request({ email: 'nobody@example.test', ...CONTEXT });

    expect(mail.sent).toEqual([]);
    expect(db.issuedTokenHashes).toEqual([]);
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PASSWORD_RESET_REQUESTED',
      actorType: 'SYSTEM',
      actorId: null,
      resourceId: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain('nobody@example.test');
  });

  it('names no address in the audit row for an account that DOES exist either', async () => {
    const { service, db } = harness();
    const user = withUser(db);

    await service.request({ email: user.email, ...CONTEXT });

    expect(JSON.stringify(auditRows(db))).not.toContain(user.email);
  });

  it('sends no link for a non-ACTIVE account, but still writes the row', async () => {
    // Carry-forward ruling 37 applied at the request end: a `LOCKED` or
    // `DISABLED` account gets no link. The row is still written, because a
    // reset attempt against an account an operator switched off is exactly what
    // an investigation wants afterwards.
    const { service, db, mail } = harness();
    const user = withUser(db, { status: 'DISABLED' });

    await service.request({ email: user.email, ...CONTEXT });

    expect(mail.sent).toEqual([]);
    expect(db.issuedTokenHashes).toEqual([]);
    expect(auditRows(db)[0]).toMatchObject({
      action: 'PASSWORD_RESET_REQUESTED',
      resourceId: user.id,
    });
  });

  it('DOES send a link to an account that has never confirmed its address', async () => {
    // Deliberate, and the opposite of `resend-verification`'s rule. The link is
    // itself proof of mailbox control, the template renders nothing an attacker
    // supplied (ruling 70, closed), and refusing would strand anyone who
    // registered and then lost their password before confirming.
    const { service, db, mail } = harness();
    const user = withUser(db, { emailVerifiedAt: null });

    await service.request({ email: user.email, ...CONTEXT });

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['passwordReset']);
  });

  it('renders no display name in the link message, even a hostile one', async () => {
    // Ruling 70 at the caller. `AuthMailer.sendPasswordReset` has no parameter
    // for a name, so this cannot regress without a signature change — asserted
    // anyway, because what reaches the body is the thing that matters, and this
    // is the only spec that drives the real template through the real service
    // with a hostile stored name actually present on the row.
    const { service, db, mail } = harness();
    const user = withUser(db, { name: 'Ada <script>alert(1)</script> https://evil.test/x' });

    await service.request({ email: user.email, ...CONTEXT });

    const sent = mail.sent[0];
    expect(sent).toBeDefined();
    for (const part of [sent?.subject ?? '', sent?.html ?? '', sent?.text ?? '']) {
      expect(part).not.toContain('evil.test');
      expect(part).not.toContain('alert(1)');
    }
  });
});

describe('reset-password', () => {
  it('refuses an unredeemable token with TOKEN_INVALID and writes nothing', async () => {
    const { service, db } = harness();

    await expect(
      service.reset({ token: 'FIXTURE_not_redeemable', password: NEW_PASSWORD, ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(names(db)).not.toContain('tx.credential.updateMany');
  });

  it('refuses a breached password BEFORE the token is spent', async () => {
    // The order is a usability decision with a security shape: a 422 must not
    // cost the user their link. The breach check runs first, so a refused
    // password leaves the token live and the same link works again.
    const { service, db } = harness({ breached: true });
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, 'FIXTURE_old_hash');

    await expect(
      service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT }),
    ).rejects.toBeInstanceOf(PasswordBreachedError);
    expect(names(db)).not.toContain('tx.verificationToken.updateMany');
    expect(names(db)).not.toContain('tx.credential.updateMany');
  });

  it('WRITES AND COMMITS THE NEW HASH BEFORE ANYTHING IS REVOKED', async () => {
    // D2, and the ordering `SessionService.revokeAllForUser`'s own docblock
    // says Task 10 owns. A revoke-then-write ordering leaves a window in which
    // the old password still mints sessions the revocation has already passed
    // over: that method cannot see a session created after its `updateMany`,
    // and nothing inside it could.
    const { service, db, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    const order = names(db);
    const written = order.indexOf('tx.credential.updateMany');
    const committed = order.indexOf('$transaction:commit');
    const revokedAt = order.indexOf('sessions.revokeAllForUser');
    expect(written).toBeGreaterThan(-1);
    expect(revokedAt).toBeGreaterThan(-1);
    // Not merely "written before revoked" — written AND COMMITTED before
    // revoked. A hash still inside an open transaction is a hash a racing login
    // cannot see, so an ordering that revoked between the write and the commit
    // would have the defect while passing a naive index comparison.
    expect(committed).toBeGreaterThan(written);
    expect(revokedAt).toBeGreaterThan(committed);
  });

  it('revokes EVERY session, with no exception', async () => {
    // D2. The user completing a reset holds none, and if an attacker holds one
    // that is precisely the session being taken away.
    const { service, db, passwords, revoked } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    expect(revoked).toEqual([{ userId: user.id, exceptSessionId: undefined }]);
  });

  it('replaces the credential with a hash of the NEW password', async () => {
    const { service, db, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    const oldHash = await passwords.hash(OLD_PASSWORD);
    db.credentials.set(user.id, oldHash);

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    const stored = db.credentials.get(user.id);
    expect(stored).toBeDefined();
    expect(stored).not.toBe(oldHash);
    expect((await passwords.verify(stored ?? null, NEW_PASSWORD)).valid).toBe(true);
    expect((await passwords.verify(stored ?? null, OLD_PASSWORD)).valid).toBe(false);
  });

  it('refuses when the credential moved under it, and leaves the link live', async () => {
    // D3 and carry-forward ruling 73's shape. The write is decided from a row
    // read before a ~40 ms hash, so the decision is stale by construction; the
    // compare-and-swap is what turns a stale decision into a refusal instead of
    // a silent overwrite of whoever committed first.
    //
    // The refusal is `TOKEN_INVALID` — the same code and message as every other
    // refusal on this endpoint, per §6's one-refusal rule — and the transaction
    // rolls back, so the link is NOT burned and a retry succeeds.
    const { service, db, passwords, revoked } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));
    db.control.replaceCredentialAfterRead = {
      userId: user.id,
      passwordHash: await passwords.hash('a sibling got there first'),
    };

    await expect(
      service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(revoked).toEqual([]);
  });

  it('refuses a LOCKED account and ROLLS BACK rather than burning the link', async () => {
    // D4 and carry-forward ruling 37. `TokenService.consume` asserts nothing
    // about the user it returns, so without this check a locked or disabled
    // account's link still redeems. Task 8's `verify-email` set the pattern:
    // the same `TOKEN_INVALID` as every other refusal, and a rollback, so a
    // link refused because an account was locked still works once an
    // administrator unlocks it.
    const { service, db, revoked } = harness();
    const user = withUser(db, { status: 'LOCKED' });
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, 'FIXTURE_old_hash');

    await expect(
      service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(names(db)).not.toContain('tx.credential.updateMany');
    expect(revoked).toEqual([]);
    expect(db.credentials.get(user.id)).toBe('FIXTURE_old_hash');
  });

  it('refuses a DISABLED account the same way', async () => {
    const { service, db } = harness();
    const user = withUser(db, { status: 'DISABLED' });
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, 'FIXTURE_old_hash');

    await expect(
      service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(db.credentials.get(user.id)).toBe('FIXTURE_old_hash');
  });

  it('sets a credential for an account that has none, rather than refusing forever', async () => {
    // A `User` with no `Credential` row is a real state — the row is a separate
    // table, and an SSO-only account will be one when Phase 11 lands. Refusing
    // here would burn nothing but would strand that account permanently, with
    // `TOKEN_INVALID` as the only explanation it could ever be given. A decision
    // this task made; the brief did not cover it.
    const { service, db, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    expect(names(db)).toContain('tx.credential.create');
    expect((await passwords.verify(db.credentials.get(user.id) ?? null, NEW_PASSWORD)).valid).toBe(
      true,
    );
  });

  it('clears a live brute-force lock, so the new password actually works (L7)', async () => {
    // `User.lockedUntil` is independent of `User.status`, which D4 checks. An
    // account that is `ACTIVE` but currently locked receives a link, completes
    // the reset, and — before this fix — was still refused at `login` with
    // `ACCOUNT_LOCKED` while holding the correct new password.
    const { service, db, passwords } = harness();
    const user = withUser(db, { emailVerifiedAt: new Date() });
    db.users.set(user.id, {
      ...user,
      lockedUntil: new Date(Date.now() + 600_000),
      failedLoginCount: 5,
    });
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    const row = db.users.get(user.id);
    expect(row?.lockedUntil).toBeNull();
    // Cleared with the lock: otherwise the account is one mistype from a fresh
    // lock the instant it is recovered.
    expect(row?.failedLoginCount).toBe(0);
  });

  it('confirms an address that a completed reset just proved (L5)', async () => {
    // Redeeming the link IS mailbox control, which is the stated reason an
    // unconfirmed account is sent one. Leaving `emailVerifiedAt` null afterwards
    // kept the account excluded from everything verification gates, while it had
    // demonstrably proved the thing verification asks for.
    const { service, db, passwords } = harness();
    const user = withUser(db, { emailVerifiedAt: null });
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    expect(db.users.get(user.id)?.emailVerifiedAt).not.toBeNull();
    expect(auditRows(db)[0]).toMatchObject({ metadata: { confirmedAddress: true } });
  });

  it('does not restamp an address that was already confirmed', async () => {
    // The instant `emailVerifiedAt` carries is when the address was FIRST
    // proved. Overwriting it on every reset would quietly turn the column into
    // "last reset", which is not what any reader of it will assume.
    const confirmedAt = new Date('2026-01-01T00:00:00.000Z');
    const { service, db, passwords } = harness();
    const user = withUser(db, { emailVerifiedAt: confirmedAt });
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    expect(db.users.get(user.id)?.emailVerifiedAt).toBe(confirmedAt);
    expect(auditRows(db)[0]).toMatchObject({ metadata: { confirmedAddress: false } });
  });

  it('writes one PASSWORD_RESET_COMPLETED row carrying the live session count', async () => {
    // D9. The COUNT rather than one row per revoked session: an unauthenticated
    // caller can trigger a reset, and a row per session would let them size the
    // session table for an account they do not own.
    const { service, db, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));
    db.liveSessionCounts.set(user.id, 3);

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'PASSWORD_RESET_COMPLETED',
      actorType: 'USER',
      actorId: user.id,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { liveSessionsAtWrite: 3 },
    });
  });

  it('puts no password, hash or token anywhere in the audit row', async () => {
    // Critical security rule 6, and `TokenService`'s own docblock: the raw
    // token exists in the link and nowhere else.
    const { service, db, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    const oldHash = await passwords.hash(OLD_PASSWORD);
    db.credentials.set(user.id, oldHash);

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    const serialised = JSON.stringify(auditRows(db));
    expect(serialised).not.toContain('FIXTURE_live_token');
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain(oldHash);
    expect(serialised).not.toContain('$argon2id$');
  });

  it('sends the password-changed notice, after the commit', async () => {
    const { service, db, mail, passwords } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));

    await service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT });

    expect(mail.sent.map((sent) => sent.templateId)).toEqual(['passwordChanged']);
    const order = names(db);
    expect(order.indexOf('sessions.revokeAllForUser')).toBeGreaterThan(
      order.indexOf('$transaction:commit'),
    );
  });

  it('does not let a failed notice send undo the reset', async () => {
    // `AuthMailer` swallows a transport failure by design. The password IS
    // changed and the sessions ARE revoked by the time this send is attempted,
    // so propagating would report failure for work that has already committed
    // and cannot be taken back.
    const { service, db, mail, passwords, revoked } = harness();
    const user = withUser(db);
    db.control.redeemableUserId = user.id;
    db.credentials.set(user.id, await passwords.hash(OLD_PASSWORD));
    mail.control.failWith = new Error('relay refused');

    await expect(
      service.reset({ token: 'FIXTURE_live_token', password: NEW_PASSWORD, ...CONTEXT }),
    ).resolves.toBeUndefined();
    expect(revoked).toHaveLength(1);
  });
});
