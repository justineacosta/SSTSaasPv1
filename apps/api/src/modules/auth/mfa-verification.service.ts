import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@sentinel/observability';
import { LOGGER, PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { MFA_SECRET_KEY } from './auth.tokens.js';
import { LOCKOUT_THRESHOLD } from './lockout.js';
import { MfaInvalidError } from './mfa.errors.js';
import { decryptMfaSecret } from './mfa-secret.js';
import type { MfaStore, MfaTransaction } from './mfa.store.js';
import {
  RECOVERY_CODE_COUNT,
  RecoveryCodesService,
  looksLikeRecoveryCode,
} from './recovery-codes.service.js';
import type { AuthRequestContext } from './request-context.js';
import {
  SessionService,
  type IssuedSession,
  type RotateSessionInput,
  type SessionResolution,
} from './session.service.js';
import { minimumStepFor, verifyTotpCode } from './totp.js';

/**
 * How many failed codes revoke the pending session.
 *
 * `security/authentication.md` §5: "Failed attempts are rate limited and lock
 * the pending session after 5." Five, and it is `LOCKOUT_THRESHOLD` rather than
 * a literal for `password-change.service.ts`'s reason one endpoint over: an
 * account owner should not have to learn two different stories about what "too
 * many attempts" means, and `login`'s ladder already fixes the number.
 */
export const MFA_ATTEMPT_LIMIT = LOCKOUT_THRESHOLD;

/**
 * The slice of `SessionService` the MFA challenge uses.
 *
 * The same narrow-port shape `SessionIssuer` and `SessionRotatingRevoker` take,
 * for the same reason. This one resolves, rotates and revokes and never issues:
 * an MFA challenge cannot mint a session out of nothing, it can only promote
 * one that a password already earned.
 */
export interface SessionPromoter {
  resolve(token: string): Promise<SessionResolution>;
  rotate(input: RotateSessionInput): Promise<IssuedSession | null>;
  revoke(sessionId: string): Promise<boolean>;
}

export interface MfaVerifyResult {
  readonly token: string;
  readonly cookieMaxAgeSeconds: number | null;
}

/**
 * `POST /api/v1/auth/mfa/verify` — the one route a `PENDING_MFA` session can
 * reach.
 *
 * # The order of operations IS the design
 *
 * 1. Resolve the pending token. It must be a live `PENDING_MFA` session.
 * 2. Read the confirmed factor.
 * 3. **Spend the credential** — the TOTP step, or the recovery code — under a
 *    compare-and-swap, inside a transaction that also writes the success audit
 *    row.
 * 4. *Then* rotate the pending session into an `ACTIVE` one.
 * 5. *Then* re-read the credential and revoke the promotion if the account's
 *    password was replaced after the pending session was created (D4).
 * 6. *Then*, after everything has committed, send the unfamiliar-sign-in notice.
 *
 * Step 3 before step 4 is deliberate and it fails in the safe direction. If the
 * rotation then fails, the code has been spent and the user types a fresh one;
 * the reverse ordering would promote a session and then discover the code was
 * already used.
 *
 * # THE ATTEMPT COUNTER IS `MFA_CHALLENGE_FAILED` ROWS, AND THERE IS NO COLUMN
 *
 * D5. §5 requires the pending session to be locked after five failures, and it
 * must survive a Redis restart — so the Redis limiter is not it. `Session` has
 * no attempt column, and this counts the append-only rows the failure path
 * already has to write, keyed on the pending session's id. No migration, and no
 * second source of truth to disagree with the audit trail. The exact device
 * `password-change.service.ts` uses for its burst notice.
 *
 * **The count is read inside the transaction that writes the row it counts, so
 * it needs a lock.** Carry-forward ruling 84, which is ruling 74 recurring
 * inside a fix round: Prisma runs interactive transactions at Postgres READ
 * COMMITTED, so concurrent failures cannot see one another's uncommitted rows,
 * several can each count exactly five, and the lock either fires more than once
 * or — worse — five parallel wrong codes each count 1 and nothing locks at all.
 * `pg_advisory_xact_lock` keyed on the pending session serialises them: READ
 * COMMITTED takes a fresh snapshot per statement, so a transaction that waits
 * sees what it waited for.
 *
 * The fifth failure **revokes the pending session**, which is the correct
 * outcome and reuses machinery that already exists: the user starts again from
 * login, which costs them the password again.
 *
 * # A code is spent before it is believed
 *
 * D6 and D7. Both credentials are consumed with a conditional `UPDATE` whose
 * predicate is the thing being consumed —
 * `lastAcceptedStep < step` for a TOTP code, `usedAt IS NULL` for a recovery
 * code — so Postgres arbitrates row by row and exactly one of two concurrent
 * requests carrying the same value reports an affected row. A `SELECT` followed
 * by an `UPDATE` passes every sequential test and lets both through; that is
 * carry-forward ruling 74's shape and this endpoint has two instances of it.
 *
 * # Mail after everything, never inside a transaction
 *
 * Carry-forward rulings 44 and 45.
 */
@Injectable()
export class MfaVerificationService {
  constructor(
    @Inject(PRISMA) private readonly store: MfaStore,
    @Inject(SessionService) private readonly sessions: SessionPromoter,
    @Inject(RecoveryCodesService) private readonly recoveryCodes: RecoveryCodesService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(MFA_SECRET_KEY) private readonly secretKey: Buffer,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async verify(
    command: AuthRequestContext & { pendingToken: string; code: string },
  ): Promise<MfaVerifyResult> {
    const resolution = await this.sessions.resolve(command.pendingToken);
    // ONE REFUSAL FOR EVERY WAY THE TOKEN CAN BE WRONG. Unknown, expired,
    // revoked and "resolved but not pending" are indistinguishable to the
    // caller — a caller holding a token that was never issued must not be able
    // to learn that one that WAS issued has merely expired.
    if (resolution.outcome !== 'resolved') throw new MfaInvalidError();
    if (resolution.session.status !== 'PENDING_MFA') throw new MfaInvalidError();

    const pending = resolution.session;
    const row = await this.store.session.findUnique({
      where: { id: pending.id },
      select: { id: true, userId: true, createdAt: true },
    });
    // Resolved from the cache and gone from Postgres. Not reachable today —
    // nothing deletes a session row — and refused rather than assumed away,
    // because D4's check has no left-hand side without `createdAt`.
    if (row === null) throw new MfaInvalidError();

    const factor = await this.store.mfaFactor.findFirst({
      where: { userId: pending.userId, type: 'TOTP' },
      select: {
        id: true,
        userId: true,
        secretEncrypted: true,
        secretKeyVersion: true,
        confirmedAt: true,
        lastAcceptedStep: true,
      },
    });
    // `confirmedAt IS NOT NULL` is the only test for "this user has MFA" (D3).
    // An unconfirmed factor is a row that exists and gates nothing.
    if (factor?.confirmedAt == null) {
      await this.recordFailure(pending.id, pending.userId, 'NO_CONFIRMED_FACTOR', command);
      throw new MfaInvalidError();
    }

    const spent = looksLikeRecoveryCode(command.code)
      ? await this.spendRecoveryCode(pending.id, pending.userId, command)
      : await this.spendTotpCode(pending.id, factor, command);

    if (spent === null) {
      await this.recordFailure(pending.id, pending.userId, 'BAD_CODE', command);
      throw new MfaInvalidError();
    }

    return this.promote(row, command, spent);
  }

  /**
   * D6. The submitted code is checked against the ±1 window with the replay
   * floor applied, and then the floor is moved — conditionally.
   *
   * The conditional `UPDATE` is the control and the in-memory check above it is
   * a fast path. Two concurrent requests both read `lastAcceptedStep = n` and
   * both compute the same accepted step; Postgres lets exactly one of them
   * satisfy `lastAcceptedStep < step`, and the loser reports `count: 0` and is
   * refused exactly as a wrong code is.
   */
  private async spendTotpCode(
    sessionId: string,
    factor: {
      id: string;
      secretEncrypted: string;
      secretKeyVersion: number | null;
      lastAcceptedStep: number | null;
    },
    command: AuthRequestContext & { code: string },
  ): Promise<SpentCredential | null> {
    let secret: Buffer;
    try {
      secret = decryptMfaSecret(this.secretKey, factor.secretEncrypted, factor.secretKeyVersion);
    } catch (error) {
      // An operational fault, not a wrong code — the row cannot be read by the
      // algorithm that wrote it, which is carry-forward ruling 25's shape one
      // table over. The factor id and NOTHING ELSE: no ciphertext, no key, no
      // fragment of either (critical security rule 6). `MfaSecretError`'s own
      // message is a constant, so binding it is safe, and it is bound rather
      // than dropped because an operator needs to know a factor has rotted.
      this.logger.error(
        { factorId: factor.id, err: error },
        'the stored MFA secret could not be decrypted; this factor cannot verify a code',
      );
      return null;
    }

    const step = verifyTotpCode({
      secret,
      code: command.code,
      atMs: Date.now(),
      minimumStep: minimumStepFor(factor.lastAcceptedStep),
    });
    if (step === null) return null;

    const now = new Date();
    const { count } = await this.store.$transaction(async (tx: MfaTransaction) =>
      tx.mfaFactor.updateMany({
        where: {
          id: factor.id,
          // Belt and braces with the confirmed check above: this statement must
          // not be able to move the floor on an unconfirmed factor.
          confirmedAt: { not: null },
          OR: [{ lastAcceptedStep: null }, { lastAcceptedStep: { lt: step } }],
        },
        data: { lastAcceptedStep: step, lastUsedAt: now },
      }),
    );
    // A REPLAY, OR A SIBLING THAT WON. Refused with the same bytes as a wrong
    // code: telling the caller "that code was right but you were second" hands
    // a useful fact to whoever watched it being typed.
    if (count === 0) return null;

    return { kind: 'TOTP', sessionId, step };
  }

  /**
   * D7. Ten Argon2id verifications, then a conditional `UPDATE` on `usedAt`.
   *
   * `recovery-codes.service.ts` owns the matching and the padding that keeps the
   * cost constant; this owns the spend. `take: RECOVERY_CODE_COUNT` bounds the
   * read to the size of one set — a user cannot accumulate more, and an
   * unbounded read here would be a way to make one request arbitrarily
   * expensive if that ever stopped being true.
   */
  private async spendRecoveryCode(
    sessionId: string,
    userId: string,
    command: AuthRequestContext & { code: string },
  ): Promise<SpentCredential | null> {
    const stored = await this.store.recoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
      take: RECOVERY_CODE_COUNT,
    });

    const matched = await this.recoveryCodes.findMatch(command.code, stored);
    if (matched === null) return null;

    const now = new Date();
    const spent = await this.store.$transaction(async (tx: MfaTransaction) => {
      // `usedAt: null` is what makes "the same code must fail the second time"
      // true under concurrency as well as sequentially.
      const { count } = await tx.recoveryCode.updateMany({
        where: { id: matched, usedAt: null },
        data: { usedAt: now },
      });
      if (count === 0) return null;
      // Counted inside the same transaction as the spend, so the number and the
      // fact it describes are one atomic fact. It is what the audit row
      // reports, and it is the number that tells a user to regenerate.
      const remaining = await tx.recoveryCode.count({ where: { userId, usedAt: null } });
      return { remaining };
    });
    if (spent === null) return null;

    return {
      kind: 'RECOVERY_CODE',
      sessionId,
      recoveryCodeId: matched,
      remaining: spent.remaining,
    };
  }

  /**
   * The promotion, and D4's check after it.
   *
   * # Ruling 50: the promotion carries its evidence
   *
   * `SessionService.rotate` **throws** `MFA_EVIDENCE_REQUIRED` on a
   * `PENDING_MFA` -> `ACTIVE` transition with no `mfaCompletedAt`, because a
   * review demonstrated a ten-minute pending session becoming a thirty-day
   * privileged one from a call that proved nothing. This is the one legitimate
   * promoter and it passes the instant the factor was actually proved.
   *
   * # H1's shape, without a password in hand (D4)
   *
   * Task 10's H1 measured 25 of 25 survivors: a login racing a completed
   * password reset kept a fully privileged session minted with the OLD
   * password. `login.service.ts` closed it by re-reading the credential after
   * the session is issued. This path has the same shape — `revokeAllForUser` is
   * one `updateMany` and cannot revoke a row that does not exist yet, so a
   * promotion whose successor lands after the reset's revoke is never swept —
   * and no password to re-verify with.
   *
   * So the predicate differs: **was the account's password replaced after this
   * pending session was created?** `Credential.updatedAt` is a `@updatedAt`
   * column that already exists, so there is no schema change.
   *
   * **The timestamp alone is NOT the predicate, and that is ruling 83.** A
   * transparent rehash on a concurrent login moves `updatedAt` without changing
   * the password, and refusing on it would refuse a legitimate promotion for
   * the duration of a parameter migration — the availability defect ruling 83
   * records, measured there at 3 of 4 concurrent sign-ins refused, with the
   * whole suite green because the only rehash test was single-threaded.
   *
   * A moved timestamp is therefore the QUESTION, not the answer, and the answer
   * is in the audit trail: a password **replacement** writes `PASSWORD_CHANGED`
   * or `PASSWORD_RESET_COMPLETED` in the same transaction as the credential
   * write (`CLAUDE.md` rule 10, and both services do it — see
   * `password-change.service.ts` and `password-reset.service.ts`), and a rehash
   * writes nothing. So the check is:
   *
   * 1. `credential.updatedAt <= pendingSession.createdAt` -> stands, no further
   *    work. This is the common case and costs one indexed read.
   * 2. Otherwise, count replacement rows for this user newer than the pending
   *    session. Zero means a rehash and the promotion stands; one or more means
   *    the password was replaced and the promotion is revoked.
   *
   * **The residual, stated rather than implied.** Step 2 delegates its
   * correctness to `CLAUDE.md` rule 10 — a future path that replaced a
   * credential without writing an audit row would pass this check. That rule is
   * enforced by review rather than by construction. The alternative predicate
   * (refuse on the timestamp alone) fails closed against that hypothetical and
   * fails **open on availability** against a real, measured one, and this
   * codebase has a ruling about the second and not the first.
   *
   * On violation the promoted session is revoked and the caller gets the same
   * refusal as a bad code.
   */
  private async promote(
    pending: { id: string; userId: string; createdAt: Date },
    command: AuthRequestContext & { code: string },
    spent: SpentCredential,
  ): Promise<MfaVerifyResult> {
    // BEFORE the rotation, for `login.service.ts`'s reason exactly: the session
    // this promotion is about to create carries this `(userId, ip, userAgent)`
    // triple, so a lookup afterwards matches itself and the notice never fires.
    const familiar = await this.isFamiliar(pending, command);
    const mfaCompletedAt = new Date();

    const rotated = await this.sessions.rotate({
      sessionId: pending.id,
      // Stated explicitly. Ruling 6 one layer up and ruling 50 at this call
      // site: this is the one call in the product that RAISES privilege, and
      // `rotate` refuses it without the evidence below.
      status: 'ACTIVE',
      mfaCompletedAt,
      ip: command.ip,
      userAgent: command.userAgent,
    });
    // The pending session was revoked or expired between the resolve and here.
    // The code is spent and that is correct — it was used, just not usefully —
    // and the caller is refused with the same bytes as a bad code.
    if (rotated === null) throw new MfaInvalidError();

    // D4. AFTER the rotation, mirroring H1's ordering. There is no third
    // interleaving: either the successor insert precedes a revocation and is
    // swept by it, or it follows, which means the credential write committed
    // first and this read observes it.
    if (!(await this.credentialStillCurrent(pending))) {
      await this.sessions.revoke(rotated.session.id);
      // No hash, no password, no fragment of either (critical security rule 6).
      this.logger.warn(
        { userId: pending.userId, sessionId: rotated.session.id },
        'the account password was replaced after this pending session was created; the promoted session was revoked',
      );
      throw new MfaInvalidError();
    }

    await this.store.$transaction(async (tx: MfaTransaction) => {
      await this.audit.record(tx, {
        // THE ACTOR REALLY IS THE ACCOUNT OWNER. They have now proved both
        // factors, which is more evidence than any other row this module
        // writes.
        actorType: 'USER',
        actorId: pending.userId,
        action: 'MFA_CHALLENGE_SUCCEEDED',
        // The SESSION, not the user. See `platform-audit.actions.ts`: the three
        // challenge rows name the pending session because that is the row the
        // control acts on and because the failure row is the attempt counter.
        resourceType: 'Session',
        resourceId: pending.id,
        metadata: {
          method: spent.kind,
          newDevice: !familiar,
          promotedSessionId: rotated.session.id,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      if (spent.kind === 'RECOVERY_CODE') {
        await this.audit.record(tx, {
          actorType: 'USER',
          actorId: pending.userId,
          action: 'MFA_RECOVERY_CODE_USED',
          resourceType: 'User',
          resourceId: pending.userId,
          // The COUNT remaining, never a code or a hash of one. It is the
          // number that decides whether the user needs to regenerate.
          metadata: { recoveryCodeId: spent.recoveryCodeId, remaining: spent.remaining },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });
      }
    });

    if (!familiar) {
      // D9, AND IT IS TASK 9'S DEBT. `login.service.ts:139-142` recorded that no
      // new-device notice is sent on the MFA arm, so an MFA-enrolled account got
      // NO unfamiliar-session notice at all. It is sent here, where the sign-in
      // actually completes: "new sign-in to your account" is a true statement
      // about this event and was a false one about a session that could do
      // nothing but type six digits.
      //
      // ONLY TO A PROVEN ADDRESS, and no user agent — ruling 71 and ruling 85.
      // `login.service.ts` applies the same two rules at its own call site.
      const user = await this.store.user.findUnique({
        where: { id: pending.userId },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      if (user !== null && user.emailVerifiedAt !== null) {
        await this.mailer.sendNewDeviceSignIn({
          to: user.email,
          occurredAt: mfaCompletedAt,
          ip: command.ip,
        });
      }
    }

    return { token: rotated.token, cookieMaxAgeSeconds: rotated.cookieMaxAgeSeconds };
  }

  private async credentialStillCurrent(pending: {
    userId: string;
    createdAt: Date;
  }): Promise<boolean> {
    const credential = await this.store.credential.findUnique({
      where: { userId: pending.userId },
      select: { passwordHash: true, updatedAt: true },
    });
    // No credential at all: a reset that has not written yet, or an account
    // whose password was removed. Either way the session this promotion just
    // made should not stand.
    if (credential === null) return false;
    if (credential.updatedAt <= pending.createdAt) return true;

    // The row moved. Ask WHY — see the docblock on `promote`.
    const replacements = await this.store.platformAuditEvent.count({
      where: {
        action: { in: ['PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED'] },
        resourceId: pending.userId,
        createdAt: { gt: pending.createdAt },
      },
    });
    return replacements === 0;
  }

  /**
   * D5. The failure row, the count it belongs to, and the lock the fifth one
   * earns — as one transaction, under a per-session advisory lock.
   *
   * **The lock is what makes "after 5" true.** Ruling 84: the count is read
   * inside the transaction that writes the row it counts, and Prisma runs
   * interactive transactions at READ COMMITTED, so without serialisation five
   * parallel wrong codes each see zero prior failures, each count 1, and
   * nothing locks — which is exactly the shape of Task 9's H1 and of the
   * burst-notice defect the Task 10 fix round shipped and had to fix again.
   *
   * Keyed per pending SESSION, so two people failing on two sessions never wait
   * on each other. Held to the end of a transaction that is one insert and one
   * count with no network call in it.
   *
   * **Counted with no time window.** A pending session lives for ten minutes and
   * is replaced by the next login, so "every failure against this session" is
   * already the bounded question. The consequence is that signing in again
   * starts a fresh five, which is correct: what is being bounded is guessing at
   * one challenge, and starting over costs the attacker the password again.
   */
  private async recordFailure(
    sessionId: string,
    userId: string,
    reason: string,
    command: AuthRequestContext,
  ): Promise<void> {
    const locked = await this.store.$transaction(async (tx: MfaTransaction) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`mfa:${sessionId}`}))) AS lock_taken`;

      await this.audit.record(tx, {
        // `SYSTEM` with a null actor, following every other failure row in this
        // module: whoever submitted the wrong code holds a password and not a
        // factor, which is precisely the case where naming the account owner
        // would be a false statement in a table that cannot be corrected.
        actorType: 'SYSTEM',
        actorId: null,
        action: 'MFA_CHALLENGE_FAILED',
        resourceType: 'Session',
        resourceId: sessionId,
        // Ours, never the submitted code or any part of it.
        metadata: { reason, userId },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      // AFTER the row is written, so the attempt that trips the threshold is
      // included in its own count — the same arithmetic `login`'s ladder uses,
      // where the fifth failure is the one that acts.
      const failures = await tx.platformAuditEvent.count({
        where: { action: 'MFA_CHALLENGE_FAILED', resourceId: sessionId },
      });

      // EXACTLY EQUAL, not `>=`. Every attempt past the fifth finds a revoked
      // session and is refused at `resolve` before reaching here, so a later
      // row is unreachable — and writing the lock row once is what keeps the
      // table from carrying two locks for one lock.
      if (failures !== MFA_ATTEMPT_LIMIT) return false;

      await this.audit.record(tx, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'MFA_PENDING_SESSION_LOCKED',
        resourceType: 'Session',
        resourceId: sessionId,
        metadata: { failures, userId },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
      return true;
    });

    if (!locked) return;

    // AFTER the commit. The revocation poisons a Redis key and writes a row
    // through `SessionService`, neither of which belongs inside a transaction
    // this service opened — and if it fails, the audit row still records that
    // the threshold was reached.
    await this.sessions.revoke(sessionId);
  }

  /**
   * "Familiar" is `login.service.ts`'s definition, asked through the same
   * predicate rather than restated.
   *
   * That file's docblock carries what it does and does not prove — it is not
   * device identity, it is exact-match on an attacker-choosable header, and the
   * first sign-in of a new account is always unfamiliar. None of that changes
   * because the question is asked one step later in the flow.
   */
  private async isFamiliar(
    pending: { id: string; userId: string },
    command: AuthRequestContext,
  ): Promise<boolean> {
    const prior = await this.store.session.findFirst({
      where: {
        userId: pending.userId,
        ip: command.ip,
        userAgent: command.userAgent,
        // THE PENDING SESSION EXCLUDES ITSELF. `login.service.ts` gets this for
        // free by asking before it issues; here the row already exists, carrying
        // the same triple this request arrived with, so without the exclusion
        // the lookup matches itself, every completion is familiar, and the
        // notice never fires — Task 9's debt closed and immediately reopened.
        id: { not: pending.id },
      },
      select: { id: true },
    });
    return prior !== null;
  }
}

type SpentCredential =
  | { readonly kind: 'TOTP'; readonly sessionId: string; readonly step: number }
  | {
      readonly kind: 'RECOVERY_CODE';
      readonly sessionId: string;
      readonly recoveryCodeId: string;
      readonly remaining: number;
    };
