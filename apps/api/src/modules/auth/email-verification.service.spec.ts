import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '@sentinel/config';
import { createLogger } from '@sentinel/observability';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { EmailVerificationService } from './email-verification.service.js';
import {
  identityStoreFake,
  type IdentityStoreFake,
  mailerFake,
  type MailerFake,
} from '../../testing/identity-fakes.js';
import { TokenInvalidError } from './token-invalid.error.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * WHAT THE FAKES CAN SHOW, AND WHAT THEY DELIBERATELY DO NOT.
 *
 * `tx.verificationToken.updateMany` here always reports `count: 0`, so the
 * redemption path below is exercised only in its refusing form. That is the
 * honest division: the accepting path depends on an `UPDATE`'s affected-row
 * count against a real row, which is exactly what a fake makes true by
 * construction — carry-forward ruling 58's family of defect. Every accepting
 * case lives in `auth.verification.integration.spec.ts` against Postgres.
 *
 * What is asserted here is the branching a database cannot show: the ordering
 * of the resend's transaction and its send, and the three-cases-one-answer
 * property of the resend.
 */

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

const CONTEXT = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

interface Harness {
  readonly service: EmailVerificationService;
  readonly db: IdentityStoreFake;
  readonly mail: MailerFake;
}

function harness(): Harness {
  const db = identityStoreFake();
  const mail = mailerFake();
  const tokens = new TokenService(db.tokenStore, TTL);
  const mailer = new AuthMailer(
    mail.mailer,
    ENV,
    tokens,
    createLogger({ service: 'test', level: 'fatal', pretty: false, silent: true }),
  );
  const service = new EmailVerificationService(
    db.store,
    tokens,
    new PlatformAuditService(),
    mailer,
  );
  return { service, db, mail };
}

function withUser(
  db: IdentityStoreFake,
  overrides: Partial<{ emailVerifiedAt: Date | null; status: string; name: string | null }> = {},
) {
  const row = {
    id: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    emailVerifiedAt: null,
    status: 'ACTIVE',
    ...overrides,
  };
  db.users.set(row.email, row);
  db.users.set(row.id, row);
  return row;
}

const names = (db: IdentityStoreFake): string[] => db.calls.map((call) => call.name);

describe('verify-email', () => {
  it('refuses an unredeemable token with TOKEN_INVALID and writes nothing', async () => {
    const { service, db } = harness();

    await expect(
      service.verify({ token: 'FIXTURE_not_a_real_token-verify_00000000', ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(names(db)).not.toContain('tx.user.update');
    expect(names(db)).not.toContain('tx.platformAuditEvent.create');
  });

  it('refuses a redeemable token whose user row has vanished, and writes nothing', async () => {
    // L4, Task 8 review. The `user === null` arm is the fail-closed branch for a
    // database anomaly, and its mutant survived BOTH lanes.
    //
    // It cannot be reached from the integration suite: `VerificationToken.userId`
    // is `onDelete: Cascade`, so deleting the user deletes the token and there is
    // no live token left to redeem. `control.redeemableUserId` exists for exactly
    // this — it fakes the OUTCOME of a redemption, never its concurrency
    // property, which `token.service.integration.spec.ts` owns.
    //
    // My first attempt at this test was vacuous and the mutation run is what
    // exposed it: with the fake's default `count: 0`, `verify` threw at
    // `consumed === null` and never reached the branch, so the test passed for
    // the wrong reason while the mutant lived. Ruling 58, found in my own fix.
    const { service, db } = harness();

    db.control.redeemableUserId = 'usr_01M0T74WZZFY9T2QS56RGF3GQ7';
    // Deliberately NO `withUser`: the token redeems and the row is not there.

    await expect(
      service.verify({ token: 'FIXTURE_not_a_real_token-verify_00000002', ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);

    // It got past the redemption — otherwise this test is the vacuous one again.
    expect(names(db)).toContain('tx.user.findUnique');
    // And then refused, rather than inventing an account to verify.
    expect(names(db)).not.toContain('tx.user.update');
    expect(names(db)).not.toContain('tx.platformAuditEvent.create');
  });

  it('refuses inside the transaction, so a rejected redemption is rolled back', async () => {
    // The redemption, the status check and the write are one transaction, and a
    // refusal must not leave the token consumed. The `$transaction:commit`
    // marker is absent because the callback threw.
    const { service, db } = harness();

    await expect(
      service.verify({ token: 'FIXTURE_not_a_real_token-verify_00000001', ...CONTEXT }),
    ).rejects.toBeInstanceOf(TokenInvalidError);
    expect(names(db)).toContain('$transaction:begin');
    expect(names(db)).not.toContain('$transaction:commit');
  });
});

describe('resend-verification', () => {
  it('issues a token, audits it and sends — in that order, the send after the commit', async () => {
    const { service, db, mail } = harness();
    withUser(db);

    await service.resend({ email: 'ada@example.test', ...CONTEXT });

    const sequence = names(db).slice(names(db).indexOf('$transaction:begin'));
    expect(sequence).toEqual([
      '$transaction:begin',
      'tx.$queryRaw',
      'tx.verificationToken.updateMany',
      'tx.verificationToken.create',
      'tx.platformAuditEvent.create',
      '$transaction:commit',
    ]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.templateId).toBe('emailVerification');
  });

  it('sends nothing when the transaction fails after the writes', async () => {
    // Ruling 44 again, on the second of the two paths that copy it.
    const { service, db, mail } = harness();
    withUser(db);
    db.control.failTransaction = new Error('commit refused');

    await expect(service.resend({ email: 'ada@example.test', ...CONTEXT })).rejects.toThrow(
      'commit refused',
    );
    expect(mail.sent).toEqual([]);
  });

  it('does nothing for an address with no account', async () => {
    const { service, db, mail } = harness();

    await expect(
      service.resend({ email: 'nobody@example.test', ...CONTEXT }),
    ).resolves.toBeUndefined();
    expect(names(db)).toEqual(['user.findUnique']);
    expect(mail.sent).toEqual([]);
  });

  it('does nothing for an address that is already verified', async () => {
    const { service, db, mail } = harness();
    withUser(db, { emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z') });

    await expect(
      service.resend({ email: 'ada@example.test', ...CONTEXT }),
    ).resolves.toBeUndefined();
    expect(mail.sent).toEqual([]);
  });

  it('does nothing for a LOCKED account', async () => {
    // Ruling 37's other half: a locked account must not be handed a fresh link
    // either. `UserStatus` is ACTIVE | LOCKED | DISABLED — there is no
    // SUSPENDED, whatever a brief may say.
    const { service, db, mail } = harness();
    withUser(db, { status: 'LOCKED' });

    await expect(
      service.resend({ email: 'ada@example.test', ...CONTEXT }),
    ).resolves.toBeUndefined();
    expect(mail.sent).toEqual([]);
  });

  it('does nothing for a DISABLED account', async () => {
    const { service, db, mail } = harness();
    withUser(db, { status: 'DISABLED' });

    await expect(
      service.resend({ email: 'ada@example.test', ...CONTEXT }),
    ).resolves.toBeUndefined();
    expect(mail.sent).toEqual([]);
  });

  it('greets an account with no name without naming its address', async () => {
    // Ruling B's rule applies to the greeting too: the recipient's address is
    // not a fallback for a missing display name.
    const { service, db, mail } = harness();
    withUser(db, { name: null });

    await service.resend({ email: 'ada@example.test', ...CONTEXT });
    expect(mail.sent[0]?.text).not.toContain('ada@example.test');
    expect(mail.sent[0]?.html).not.toContain('ada@example.test');
  });

  it('does not reach the caller when the send fails', async () => {
    // The sharper half of the same argument as registration's: this route sends
    // ONLY for an address that exists and is unverified, so a propagated send
    // failure would be a direct answer to "does this address exist".
    const { service, db, mail } = harness();
    withUser(db);
    mail.control.failWith = new Error('550 mailbox unavailable');

    await expect(
      service.resend({ email: 'ada@example.test', ...CONTEXT }),
    ).resolves.toBeUndefined();
  });

  it('puts no raw token in the audit event', async () => {
    const { service, db } = harness();
    withUser(db);

    await service.resend({ email: 'ada@example.test', ...CONTEXT });
    const event = db.calls.find((call) => call.name === 'tx.platformAuditEvent.create')?.args as
      { metadata?: Record<string, unknown> } | undefined;
    const serialised = JSON.stringify(event);
    for (const hash of db.issuedTokenHashes) expect(serialised).not.toContain(hash);
    // The exact key set, for the reason recorded in `registration.service.spec.ts`:
    // the fake never sees the raw token, so a substring search cannot catch a
    // mutant that puts it in the metadata.
    expect(Object.keys(event?.metadata ?? {})).toEqual(['verificationTokenId']);
    expect(event).toMatchObject({ action: 'EMAIL_VERIFICATION_RESENT', actorType: 'USER' });
  });
});
