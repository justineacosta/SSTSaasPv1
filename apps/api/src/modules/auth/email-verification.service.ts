import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import type { IdentityStore, IdentityTransaction } from './identity.store.js';
import type { AuthRequestContext } from './request-context.js';
import { TokenInvalidError } from './token-invalid.error.js';
import { TokenService } from './token.service.js';

/**
 * The only `UserStatus` a verification or a resend acts for.
 *
 * Carry-forward ruling 37: `TokenService.consume` asserts nothing about the
 * user it returns, the FK cascade only clears a *deleted* user's rows, and
 * ruling 9 records that there is no row-level security behind
 * `VerificationToken`. So a `LOCKED` or `DISABLED` user's verification link
 * still redeems unless the endpoint checks — and this constant is that check.
 *
 * `UserStatus` is `ACTIVE | LOCKED | DISABLED` in `schema.prisma`. There is no
 * `SUSPENDED` arm; that value belongs to `OrganizationStatus`.
 */
const ACTIVE_USER_STATUS = 'ACTIVE';

export interface VerifyEmailCommand extends AuthRequestContext {
  /** The raw token from the link. Hashed by `TokenService`; never stored, never logged. */
  readonly token: string;
}

export interface ResendVerificationCommand extends AuthRequestContext {
  /** Already normalised by `emailSchema` — trimmed and lower-cased. */
  readonly email: string;
}

/**
 * `POST /api/v1/auth/verify-email` and `POST /api/v1/auth/resend-verification`.
 *
 * # One refusal code for every bad token
 *
 * `TokenInvalidError` / `TOKEN_INVALID` already covers unknown, expired,
 * consumed and superseded alike, and the non-`ACTIVE` user below joins them
 * rather than getting a code of its own. A fifth distinguishable outcome would
 * be a fifth thing a caller can learn by submitting values, which is what turns
 * a consume endpoint into an oracle.
 *
 * # The resend answers identically in all three cases
 *
 * Ruling G: no such address, an address that exists and is unverified, and an
 * address that exists and is already verified all produce the same status and
 * the same body. Only the middle one sends anything.
 *
 * **THE RESIDUAL, MEASURED RATHER THAN ASSUMED, AND IT IS NOT SMALL.** Only the
 * middle case writes a row and sends a message. Measured through the real
 * application on 2026-08-28, 25 samples per case: no account 4.0 ms median
 * (3.6-4.9), already confirmed 4.2 ms (3.6-5.9), awaiting confirmation 8.6 ms
 * (7.7-12.4). **The ranges do not overlap** — any single response over about
 * 7 ms is the awaiting-confirmation case — so the latency is a reliable oracle
 * for "this address has an unconfirmed account" even though the response is
 * byte-identical. A real SMTP relay widens the gap rather than narrowing it.
 *
 * Closing it means moving the send off the response path, which needs a queue:
 * Phase 4, per ADR-0016 and carry-forward ruling 45. It is recorded here and in
 * `security/authentication.md` §6 rather than left for someone to find, and no
 * document may call this endpoint enumeration-resistant without the
 * qualification.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
  ) {}

  /**
   * Redeems a verification token and stamps `emailVerifiedAt`.
   *
   * **The redemption, the status check and the write are one transaction.** A
   * token consumed for a user whose row then fails to update would be burned
   * for nothing, and no caller can un-consume one. `consumeInTransaction`
   * exists for this; the concurrency property that makes single-use real is the
   * conditional `UPDATE` inside it and does not depend on the transaction.
   *
   * **A refusal rolls the redemption back**, so a locked account's link is
   * still live if an administrator later unlocks it. The alternative — burn the
   * token and refuse — destroys a credential in exchange for nothing, since the
   * refusal is identical either way and the endpoint is rate limited per IP.
   * The cost of this choice is that a stolen link for a locked account can be
   * retried; the cost of the other is that a legitimately locked user has to
   * ask for a new link after being unlocked. Neither is a security difference
   * and this one is the kinder failure.
   */
  async verify(command: VerifyEmailCommand): Promise<void> {
    await this.store.$transaction(async (tx: IdentityTransaction) => {
      const consumed = await this.tokens.consumeInTransaction(tx, {
        token: command.token,
        purpose: 'EMAIL_VERIFICATION',
      });
      if (consumed === null) throw new TokenInvalidError();

      const user = await tx.user.findUnique({ where: { id: consumed.userId } });
      // `null` is a database anomaly — the FK cascade deletes a user's tokens
      // with them — and fails closed rather than inventing an account.
      if (user === null) throw new TokenInvalidError();
      if (user.status !== ACTIVE_USER_STATUS) throw new TokenInvalidError();

      await tx.user.update({
        where: { id: user.id },
        // The instant the token was consumed, not a second `new Date()`. Two
        // readings of the clock in one operation are two facts that can
        // disagree, and this row is the one an investigation reads.
        data: { emailVerifiedAt: consumed.consumedAt },
      });

      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: user.id,
        action: 'EMAIL_VERIFIED',
        resourceType: 'User',
        resourceId: user.id,
        // Neither the token nor its hash. `wasAlreadyVerified` is the one fact
        // worth keeping: a second verification of an already-verified address
        // means somebody held a live link they should not have.
        metadata: { wasAlreadyVerified: user.emailVerifiedAt !== null },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });
  }

  /**
   * Issues a fresh verification token and sends it, or does nothing.
   *
   * **The new link invalidates the old one by construction**, because
   * `TokenService.issueInTransaction` supersedes every live token for that
   * `(userId, purpose)` under an advisory lock before inserting — and since
   * Task 8 the partial unique index makes it the database's invariant too.
   * Ruling G says verify that rather than assume it, and
   * `auth.verification.integration.spec.ts` does: it resends, then submits the
   * first link and requires `TOKEN_INVALID`.
   */
  async resend(command: ResendVerificationCommand): Promise<void> {
    const user = await this.store.user.findUnique({ where: { email: command.email } });
    // Three silent returns, one response. No account, an account that is
    // already verified, and an account that is not `ACTIVE` all end here — and
    // an attacker learns nothing from any of them, because the controller
    // returns the same body regardless of what this method did.
    if (user === null) return;
    if (user.emailVerifiedAt !== null) return;
    if (user.status !== ACTIVE_USER_STATUS) return;

    const issued = await this.store.$transaction(async (tx: IdentityTransaction) => {
      const token = await this.tokens.issueInTransaction(tx, {
        userId: user.id,
        purpose: 'EMAIL_VERIFICATION',
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: user.id,
        action: 'EMAIL_VERIFICATION_RESENT',
        resourceType: 'User',
        resourceId: user.id,
        metadata: { verificationTokenId: token.id },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
      return token;
    });

    // After the commit. Ruling 44.
    await this.mailer.sendVerification({
      to: user.email,
      token: issued.token,
    });
  }
}
