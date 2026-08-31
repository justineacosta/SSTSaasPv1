import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { BreachCheckService } from './breach-check.service.js';
import {
  type IdentityStore,
  type IdentityTransaction,
  type IdentityUserRow,
  isUniqueConstraintViolation,
} from './identity.store.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordService } from './password.service.js';
import type { AuthRequestContext } from './request-context.js';
import { TokenService } from './token.service.js';

export interface RegisterCommand extends AuthRequestContext {
  /** Already normalised by `emailSchema` — trimmed and lower-cased. */
  readonly email: string;
  readonly password: string;
  readonly name: string | null;
}

/**
 * `POST /api/v1/auth/register`.
 *
 * # The response is identical whether or not the address exists
 *
 * `security/authentication.md` §7 requires it, and the plan makes it a
 * byte comparison rather than an eyeball check —
 * `auth.enumeration.integration.spec.ts` compares the two responses status
 * line, header set and body. **The difference between the two paths lives in a
 * mailbox and never on the wire**: a new address gets a verification link, an
 * address that already exists gets `registrationAttempt` (ruling B), and the
 * HTTP response is the same object either way.
 *
 * # Both paths pay for the Argon2id hash
 *
 * `hash()` is called before the lookup that decides which path this is, so the
 * branch cannot skip it. This is the mirror image of carry-forward ruling 21:
 * on login the *absent* account is the one that would skip the work, and
 * `PasswordService.verify` takes a nullable stored hash so it cannot; on
 * registration the *existing* account is the one that could skip it, and the
 * ordering here is what stops that.
 *
 * A measured residual, stated rather than implied: the two paths do different
 * amounts of database work after the hash — four writes against one — so they
 * are not equal-cost, only dominated by a cost they share. Measured through the
 * real application on 2026-08-28, 25 samples each: a new address 47.8 ms median
 * (41.4-57.6), an address already in use 44.5 ms (37.9-56.7). The ranges overlap
 * almost entirely, so a single observation separates nothing. **No statistical
 * timing assertion is committed for this**: 3.3 ms of median difference on
 * ~46 ms would need a large, quiet sample to hold and would be flake in CI,
 * which is a worse trade than the assertion the spec does make — that the hash
 * HAPPENS on both paths.
 *
 * # Everything in one transaction, and the mail after it commits
 *
 * Carry-forward ruling 44. `TokenService.issueInTransaction` exists so the
 * `User`, the `Credential`, the verification token and the audit event are one
 * atomic write; `AuthMailer` takes no transaction handle so a send cannot be
 * put inside one by accident. `registration.service.spec.ts` asserts a
 * transaction that throws produces **zero** sends. This is the pattern Tasks
 * 10, 11 and 15 copy.
 *
 * # What this endpoint does not decide
 *
 * The breach check is off by default and fails open (carry-forward ruling 28),
 * so a password that reaches storage here is never *known* unbreached — the
 * refusal below is one that may happen, not a guarantee.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(BreachCheckService) private readonly breachCheck: BreachCheckService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
  ) {}

  async register(command: RegisterCommand): Promise<void> {
    // FIRST, and before anything that could distinguish the two paths. A
    // breached password is refused for an address that exists and one that does
    // not alike, so `PASSWORD_BREACHED` says something about the password and
    // nothing about the account. ADR-0015: this fails open, so it is a refusal
    // that may happen rather than a check that ran.
    if (await this.breachCheck.isBreached(command.password)) throw new PasswordBreachedError();

    // Unconditionally, and before the lookup. See the class docblock.
    const passwordHash = await this.passwords.hash(command.password);

    const existing = await this.store.user.findUnique({ where: { email: command.email } });
    if (existing !== null) {
      await this.recordBlockedAttempt(existing, command);
      return;
    }

    try {
      await this.createAccount(command, passwordHash);
    } catch (error) {
      // TWO REQUESTS REGISTERING THE SAME NEW ADDRESS AT THE SAME INSTANT.
      //
      // `User.email` is `@unique`, so the loser of that race gets P2002 — after
      // the lookup above returned null for both of them. Letting it out would
      // be a 500 for one caller and a 200 for the other, on the same input,
      // which is an existence oracle that only needs a second request to open.
      // The loser is treated exactly as if the address had already existed when
      // it looked, which by then it has.
      if (!isUniqueConstraintViolation(error)) throw error;
      const winner = await this.store.user.findUnique({ where: { email: command.email } });
      if (winner !== null) await this.recordBlockedAttempt(winner, command);
      return;
    }
  }

  /**
   * The new-account path: four rows and one email.
   *
   * The audit event's `actorType` is `USER` and its `actorId` is the account
   * just created — the person registering is the actor, and by the time the row
   * is written they have an id.
   */
  private async createAccount(command: RegisterCommand, passwordHash: string): Promise<void> {
    const userId = newId('usr');

    const issued = await this.store.$transaction(async (tx: IdentityTransaction) => {
      await tx.user.create({
        data: { id: userId, email: command.email, name: command.name },
      });
      await tx.credential.create({
        data: { id: newId('crd'), userId, passwordHash },
      });
      const token = await this.tokens.issueInTransaction(tx, {
        userId,
        purpose: 'EMAIL_VERIFICATION',
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: userId,
        action: 'USER_REGISTERED',
        resourceType: 'User',
        resourceId: userId,
        // THE RAW TOKEN IS NOT HERE AND MUST NEVER BE. `TokenService`'s own
        // docblock says the raw value exists nowhere but the mail; the token
        // ROW's id is a safe correlation handle and the secret is not.
        metadata: { verificationTokenId: token.id, hasName: command.name !== null },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
      return token;
    });

    // After the commit. Ruling 44.
    await this.mailer.sendVerification({
      to: command.email,
      token: issued.token,
    });
  }

  /**
   * The existing-account path: one audit row and one email, and no change to
   * the account whatsoever.
   *
   * The password just hashed is discarded here. It is never compared against
   * the stored credential and never stored — a registration form is not a login
   * form, and treating a matching password as "the same person" would turn this
   * endpoint into a credential check with no rate limit of its own.
   *
   * `actorType` is `SYSTEM` and `actorId` is null: the actor is an
   * unauthenticated caller who may be anybody, and `ActorType` has no arm for
   * that. Naming the existing user as the actor would be a false statement in
   * an append-only table — the whole point of the row is that it was probably
   * *not* them.
   */
  private async recordBlockedAttempt(
    existing: IdentityUserRow,
    command: RegisterCommand,
  ): Promise<void> {
    const occurredAt = new Date();

    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await this.audit.record(tx, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'REGISTRATION_BLOCKED_EXISTING_EMAIL',
        resourceType: 'User',
        resourceId: existing.id,
        // No address, no password, nothing derived from either. The row is
        // already joined to the account by `resourceId`, so repeating the
        // address would add nothing and would put a personal identifier in a
        // table nobody has to redact yet.
        metadata: { alreadyVerified: existing.emailVerifiedAt !== null },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });

    // The IP and user agent went into the audit row above and stop there. H1:
    // they are the caller's, this message goes to the account owner, and
    // `AuthMailer.sendRegistrationAttempt` has no parameter for them.
    await this.mailer.sendRegistrationAttempt({
      to: existing.email,
      occurredAt,
    });
  }
}
