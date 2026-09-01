import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { MFA_SECRET_KEY } from './auth.tokens.js';
import { InvalidCredentialsError } from './invalid-credentials.error.js';
import { MfaAlreadyEnabledError, MfaNotEnabledError } from './mfa.errors.js';
import { MfaInvalidError } from './mfa.errors.js';
import { decryptMfaSecret, encryptMfaSecret, generateTotpSecret } from './mfa-secret.js';
import type { MfaStore, MfaTransaction } from './mfa.store.js';
import { PasswordService } from './password.service.js';
import { RecoveryCodesService } from './recovery-codes.service.js';
import type { AuthRequestContext } from './request-context.js';
import { base32Encode } from './base32.js';
import { NEVER_ACCEPTED_STEP, minimumStepFor, otpauthUri, verifyTotpCode } from './totp.js';

/**
 * `POST /api/v1/auth/mfa/enroll`, `/confirm`, `/disable` and
 * `/recovery-codes` — the four authenticated MFA management routes.
 *
 * # Three of the four require the current password, and that is §5's rule
 *
 * `security/authentication.md` §5: "Enabling or disabling MFA requires the
 * current password, writes an audit event, and emails the user." Both halves of
 * that sentence are account-takeover steps if they are missing. Somebody
 * holding a stolen session who can **disable** the factor has removed the only
 * control that survives a stolen password; somebody who can **enrol their own**
 * authenticator has locked the real owner out rather than merely read their
 * data. Regenerating recovery codes is the same act one step over — it
 * invalidates the ten codes the owner printed and issues ten the attacker
 * holds.
 *
 * `/confirm` is the exception and carries no password. It is reachable only in
 * the window between an enrolment and its confirmation, the password was proved
 * to open that window, and requiring it twice in one flow buys nothing.
 *
 * **Carry-forward ruling 21 applies here exactly as on login.**
 * `PasswordService.verify(storedHash: string | null, password)` performs a full
 * Argon2id verification against a per-process dummy when the hash is `null`,
 * and this service calls it with `null` rather than branching around it.
 *
 * # An unconfirmed factor is not MFA, and abandoning enrolment leaves no trace
 *
 * D3 and carry-forward ruling 7. `confirmedAt IS NOT NULL` is the ONLY test for
 * "this user has MFA" — `login.service.ts`'s `confirmedFactor` already asks it
 * that way and this service asks the same question rather than writing a second
 * predicate that could drift from it.
 *
 * `MfaFactor` has `@@unique([userId, type])`, so an abandoned unconfirmed row
 * occupies the slot and a naive second enrolment dies on P2002 — a user who
 * closes the tab has locked themselves out of ever enabling MFA. Enrolment
 * therefore deletes any **unconfirmed** factor and creates a fresh one, in one
 * transaction. It never touches a confirmed one: that is
 * `MfaAlreadyEnabledError`, a 409, and the refusal is the security half of the
 * fix.
 *
 * # Mail after the commit, never inside it
 *
 * Carry-forward rulings 44 and 45, and the pattern `registration.service.ts`
 * set. `AuthMailer` takes no transaction handle, so a send inside one is
 * awkward to write rather than easy to do by accident. A failed send is
 * swallowed by `AuthMailer` and never changes the response — and here that
 * swallowing is a real cost, named in ruling 45: `mfaDisabled` is the message
 * that makes an account takeover visible to its victim.
 */
@Injectable()
export class MfaEnrolmentService {
  constructor(
    @Inject(PRISMA) private readonly store: MfaStore,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RecoveryCodesService) private readonly recoveryCodes: RecoveryCodesService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(MFA_SECRET_KEY) private readonly secretKey: Buffer,
  ) {}

  /**
   * Generates a secret, stores it encrypted on an UNCONFIRMED factor, and
   * returns it exactly once.
   *
   * The secret is returned by this call and by nothing else. There is no
   * endpoint that reads it back: `MfaFactor.secretEncrypted` exists to be
   * recomputed against, not to be shown twice, and a "show me my secret again"
   * route would be a way to lift a second factor out of a stolen session.
   */
  async enroll(
    command: AuthRequestContext & { userId: string; password: string },
  ): Promise<{ secret: string; otpauthUri: string }> {
    await this.requirePassword(command, 'ENROLL');

    const existing = await this.factorFor(command.userId);
    // BEFORE anything is written. Re-enrolling over a working factor without
    // proving a code is an account-takeover step (D3).
    if (existing?.confirmedAt != null) throw new MfaAlreadyEnabledError();

    const user = await this.store.user.findUnique({
      where: { id: command.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    // Unreachable behind the authentication guard, which resolved a session
    // whose `userId` has a `Cascade` foreign key to this row. Handled rather
    // than asserted, because the alternative is a 500.
    if (user === null) throw new MfaNotEnabledError();

    const secret = generateTotpSecret();
    const sealed = encryptMfaSecret(this.secretKey, secret);
    const factorId = newId('mfa');

    await this.store.$transaction(async (tx: MfaTransaction) => {
      // RULING 7. Delete-then-create rather than upsert, and the predicate is
      // `confirmedAt: null` so the statement CANNOT express replacing a
      // confirmed factor. `count: 0` is the ordinary case — a first enrolment —
      // and is not checked, because "there was no abandoned attempt" is not an
      // error.
      await tx.mfaFactor.deleteMany({ where: { userId: command.userId, confirmedAt: null } });
      await tx.mfaFactor.create({
        data: {
          id: factorId,
          userId: command.userId,
          type: 'TOTP',
          secretEncrypted: sealed.ciphertext,
          // RULING 8. Written explicitly on every row rather than left NULL.
          secretKeyVersion: sealed.keyVersion,
          confirmedAt: null,
          // D6's floor starts at -1 rather than NULL so that step 0 — 1 January
          // 1970, a real step counter — is not indistinguishable from "no code
          // accepted". The column is nullable for rows this task did not write.
          lastAcceptedStep: NEVER_ACCEPTED_STEP,
        },
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: command.userId,
        action: 'MFA_ENROLMENT_STARTED',
        resourceType: 'User',
        resourceId: command.userId,
        // NO SECRET, no fragment of one, and no ciphertext (critical security
        // rule 6). The factor id is ours and identifies the row, which is what
        // an investigation needs.
        metadata: { factorId, keyVersion: sealed.keyVersion },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });

    return {
      // Unpadded base32, which is what a user types in by hand when a camera
      // will not focus, and what the URI carries.
      secret: base32Encode(secret, { padding: false }),
      otpauthUri: otpauthUri({ email: user.email, secret }),
    };
  }

  /**
   * Proves one code from the enrolled authenticator, enables the factor, and
   * issues the ten recovery codes.
   *
   * The recovery codes are generated and hashed BEFORE the transaction opens:
   * ten Argon2id hashes is a second of CPU at production parameters, and
   * holding a Postgres transaction open across it would put every confirmation
   * in contention with everything else touching this user's rows. The same
   * ordering `password-change.service.ts` uses for one hash.
   */
  async confirm(
    command: AuthRequestContext & { userId: string; code: string },
  ): Promise<{ recoveryCodes: string[] }> {
    const factor = await this.factorFor(command.userId);
    if (factor === null) throw new MfaNotEnabledError();
    if (factor.confirmedAt !== null) throw new MfaAlreadyEnabledError();

    const secret = decryptMfaSecret(
      this.secretKey,
      factor.secretEncrypted,
      factor.secretKeyVersion,
    );
    const step = verifyTotpCode({
      secret,
      code: command.code,
      atMs: Date.now(),
      minimumStep: minimumStepFor(factor.lastAcceptedStep),
    });
    if (step === null) throw new MfaInvalidError();

    const codes = this.recoveryCodes.generate();
    const hashes = await this.recoveryCodes.hashAll(codes);
    const now = new Date();

    const enabled = await this.store.$transaction(async (tx: MfaTransaction) => {
      // `confirmedAt: null` in the predicate. A second confirmation of a factor
      // somebody else already confirmed reports `count: 0` and is refused,
      // rather than silently reissuing recovery codes for it.
      //
      // D6's floor is written here too: the code just proved is spent, so it
      // cannot be replayed at `mfa/verify` inside its ±1 window.
      const { count } = await tx.mfaFactor.updateMany({
        where: { id: factor.id, confirmedAt: null },
        data: { confirmedAt: now, lastAcceptedStep: step, lastUsedAt: now },
      });
      if (count === 0) return null;

      // The whole set is replaced, not appended to. A confirmation that
      // inherited codes from a previous enrolment would leave the earlier
      // printout live against a factor its holder cannot use.
      await tx.recoveryCode.deleteMany({ where: { userId: command.userId } });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({
          id: newId('rcv'),
          userId: command.userId,
          codeHash,
        })),
      });

      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: command.userId,
        action: 'MFA_ENABLED',
        resourceType: 'User',
        resourceId: command.userId,
        // The COUNT of codes issued, never a code or a hash of one.
        metadata: { factorId: factor.id, recoveryCodesIssued: hashes.length },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      const user = await tx.user.findUnique({
        where: { id: command.userId },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      return { email: user?.email ?? null };
    });

    if (enabled === null) throw new MfaAlreadyEnabledError();

    if (enabled.email !== null) {
      // RULING 44: after the commit, never inside it. Ruling 85: no display
      // name, and the signature has no parameter for one.
      await this.mailer.sendMfaEnabled({
        to: enabled.email,
        occurredAt: now,
        ip: command.ip,
      });
    }

    return { recoveryCodes: codes };
  }

  /**
   * Turns the factor off, having required the current password.
   *
   * **The factor and every recovery code go in the same transaction as the
   * audit row.** `CLAUDE.md` rule 10, and here the transaction is the control
   * rather than a best effort: a `MFA_DISABLED` row missing because a write
   * failed after the factor was deleted is the exact evidence an incident
   * review needs and the exact row that would not be there.
   *
   * **Sessions are deliberately NOT revoked**, and that is a decision rather
   * than an omission. Disabling MFA lowers the account's protection but proves
   * the password, so the caller has demonstrated more than an ordinary request
   * does; signing every device out would punish the legitimate user for a
   * settings change. The takeover case is covered by the notice, which reaches
   * the owner's mailbox whether or not the attacker holds the session.
   */
  async disable(command: AuthRequestContext & { userId: string; password: string }): Promise<void> {
    await this.requirePassword(command, 'DISABLE');

    const factor = await this.factorFor(command.userId);
    if (factor?.confirmedAt == null) throw new MfaNotEnabledError();

    const now = new Date();
    const disabled = await this.store.$transaction(async (tx: MfaTransaction) => {
      const { count } = await tx.mfaFactor.deleteMany({ where: { userId: command.userId } });
      // A sibling disable committed while this one was verifying the password.
      // The end state the caller asked for is the end state they have, but
      // writing a second `MFA_DISABLED` row would put two disables in an
      // append-only table for one act.
      if (count === 0) return null;

      await tx.recoveryCode.deleteMany({ where: { userId: command.userId } });

      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: command.userId,
        action: 'MFA_DISABLED',
        resourceType: 'User',
        resourceId: command.userId,
        metadata: { factorId: factor.id },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      const user = await tx.user.findUnique({
        where: { id: command.userId },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      return { email: user?.email ?? null };
    });

    if (disabled === null) throw new MfaNotEnabledError();

    if (disabled.email !== null) {
      await this.mailer.sendMfaDisabled({ to: disabled.email, occurredAt: now, ip: command.ip });
    }
  }

  /**
   * Throws the whole recovery set away and issues ten new ones.
   *
   * Requires the current password for the reason in the class docblock: this
   * invalidates the ten codes the owner printed, so from a stolen session it is
   * a way to make the account's break-glass credential be one the attacker
   * holds.
   *
   * **No email.** `security/authentication.md` §5 requires a notice for
   * enabling and disabling and names none for regeneration, and there is no
   * template for it — adding an eighth notice is a Task 5 registry change with
   * its own assertions to satisfy (ruling 43). Recorded in this task's report as
   * a gap rather than quietly filled with the wrong template.
   */
  async regenerateRecoveryCodes(
    command: AuthRequestContext & { userId: string; password: string },
  ): Promise<{ recoveryCodes: string[] }> {
    await this.requirePassword(command, 'REGENERATE_RECOVERY_CODES');

    const factor = await this.factorFor(command.userId);
    if (factor?.confirmedAt == null) throw new MfaNotEnabledError();

    const codes = this.recoveryCodes.generate();
    const hashes = await this.recoveryCodes.hashAll(codes);

    await this.store.$transaction(async (tx: MfaTransaction) => {
      // Delete the whole set and issue ten, in one transaction (D7). A partial
      // failure that left the old set deleted and the new one unwritten would
      // leave a user with a factor and no way back in if they lost it.
      await tx.recoveryCode.deleteMany({ where: { userId: command.userId } });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({
          id: newId('rcv'),
          userId: command.userId,
          codeHash,
        })),
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: command.userId,
        action: 'MFA_RECOVERY_CODES_REGENERATED',
        resourceType: 'User',
        resourceId: command.userId,
        metadata: { factorId: factor.id, recoveryCodesIssued: hashes.length },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });

    return { recoveryCodes: codes };
  }

  /**
   * One Argon2id verification, always, and the denial row `security/audit.md`
   * §3 requires.
   *
   * **No state changes on the denial**, so there is nothing for the event to be
   * atomic with. A transaction is still opened because
   * `PlatformAuditService.record` writes through a handle the caller passes in
   * and never opens its own — §2's rule expressed as a signature.
   *
   * The failure counter is deliberately untouched, following
   * `password-change.service.ts`: a caller who could lock an account by failing
   * here is a caller who could lock it with a stolen session, and the ladder's
   * `ACCOUNT_LOCKED` refusal would become a distinguishable outcome on an
   * authenticated route.
   */
  private async requirePassword(
    command: AuthRequestContext & { userId: string; password: string },
    operation: 'ENROLL' | 'DISABLE' | 'REGENERATE_RECOVERY_CODES',
  ): Promise<void> {
    const stored = await this.store.credential.findUnique({
      where: { userId: command.userId },
      select: { passwordHash: true, updatedAt: true },
    });
    // `?? null` rather than an optional: a `User` with no `Credential` row is a
    // real state, and it takes the same nullable-hash path an absent account
    // takes on login rather than a cheaper one of its own (ruling 21).
    const verification = await this.passwords.verify(
      stored?.passwordHash ?? null,
      command.password,
    );
    if (verification.valid) return;

    await this.store.$transaction(async (tx: MfaTransaction) => {
      await this.audit.record(tx, {
        // `SYSTEM` with a null actor, following every other failure row in this
        // module. Somebody holding this session could not produce the password,
        // which is exactly why naming the account owner as the actor would be a
        // false statement in a table that cannot be corrected.
        actorType: 'SYSTEM',
        actorId: null,
        action: 'MFA_MANAGEMENT_DENIED',
        resourceType: 'User',
        resourceId: command.userId,
        // Ours, never a caller-supplied string, and no fragment of the password
        // or of either hash (critical security rule 6).
        metadata: { operation, reason: 'WRONG_PASSWORD' },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });

    // The same 401 `login` and `change-password` give. It is not
    // `MfaInvalidError`: nothing about a factor was wrong, the password was.
    throw new InvalidCredentialsError();
  }

  private async factorFor(userId: string) {
    return this.store.mfaFactor.findFirst({
      where: { userId, type: 'TOTP' },
      select: {
        id: true,
        userId: true,
        secretEncrypted: true,
        secretKeyVersion: true,
        confirmedAt: true,
        lastAcceptedStep: true,
      },
    });
  }
}
