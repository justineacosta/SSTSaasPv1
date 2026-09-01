import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { BreachCheckService } from './breach-check.service.js';
import type { IdentityStore, IdentityTransaction } from './identity.store.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordService } from './password.service.js';
import type { AuthRequestContext } from './request-context.js';
import { SessionService } from './session.service.js';
import { TokenInvalidError } from './token-invalid.error.js';
import { TokenService } from './token.service.js';

/**
 * The only `UserStatus` a reset may be requested for or completed against.
 *
 * Carry-forward ruling 37, and this service is the third caller to need the
 * constant after `email-verification.service.ts` and `login.service.ts`:
 * `TokenService.consume` asserts nothing about the user it returns, the FK
 * cascade only clears a *deleted* user's rows, and ruling 9 records that there
 * is no row-level security behind `VerificationToken`. A `LOCKED` or `DISABLED`
 * account's link would otherwise redeem and hand back a working credential.
 *
 * `UserStatus` is `ACTIVE | LOCKED | DISABLED` in `schema.prisma`. There is no
 * `SUSPENDED` arm; that value belongs to `OrganizationStatus`.
 */
const ACTIVE_USER_STATUS = 'ACTIVE';

/**
 * The slice of `SessionService` this service uses.
 *
 * The same narrow-port shape `SessionIssuer` and `SessionRevoker` take, for the
 * same reason: a service typed against the whole session machine is a service
 * whose every spec is either a mock of the world or an integration test. A
 * reset revokes in bulk and never issues, resolves or rotates.
 */
export interface SessionBulkRevoker {
  revokeAllForUser(
    userId: string,
    options?: { exceptSessionId?: string | undefined },
  ): Promise<number>;
}

export interface ForgotPasswordCommand extends AuthRequestContext {
  /** Already normalised by `emailSchema` — trimmed and lower-cased. */
  readonly email: string;
}

export interface ResetPasswordCommand extends AuthRequestContext {
  /** The raw token from the link. Hashed by `TokenService`; never stored, never logged. */
  readonly token: string;
  readonly password: string;
}

/**
 * `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password`.
 *
 * # `forgot-password` answers the same thing three times over
 *
 * D5. An address with no account, an address awaiting confirmation, and a fully
 * active account all produce `{ status: 'RESET_REQUESTED' }`. Only some of them
 * send anything, and `auth.enumeration.integration.spec.ts` proves the
 * equality by byte comparison rather than by inspection.
 *
 * **THE TIMING RESIDUAL IS REAL AND IT IS ACCEPTED, NOT FIXED.** A path that
 * sends pays an SMTP round trip and a path that does not costs nothing, so the
 * latency separates the cases even though the bytes do not. That is
 * carry-forward ruling 68 on a third endpoint — the resend had it first and the
 * failed-login burst notice second (ruling 78) — and it is **not closable
 * before the Phase 4 queue**, because the difference is a real send happening
 * on the response path. It is measured rather than asserted about: the figures
 * are in this task's report and in `security/authentication.md` §6, and no
 * document may call this endpoint enumeration-resistant without the
 * qualification.
 *
 * **An account that has never confirmed its address still gets a link**, which
 * is the opposite of `resend-verification`'s rule and is deliberate. The link is
 * itself the proof of mailbox control, the template renders nothing a caller
 * supplied (ruling 70, closed by this task), and refusing would permanently
 * strand anybody who registered and then lost their password before confirming.
 * A `LOCKED` or `DISABLED` account gets none, because a reset is not the way
 * back from an administrative decision.
 *
 * # `reset-password` writes the credential BEFORE it revokes anything
 *
 * D2, and `SessionService.revokeAllForUser`'s own docblock names this as the
 * ordering only this task can get right: *"A password change must write the new
 * hash before calling this, so that a racing login cannot mint a session with
 * the old credential once this call has finished."* `revokeLiveForUser` is one
 * `updateMany` whose predicate is evaluated at execution time, so it catches a
 * session created *during* the call (ruling 51) — what it cannot catch is one
 * created *after* it, and the only thing that prevents that is the old password
 * having already stopped working. The transaction is therefore committed before
 * the revocation runs, not merely written.
 *
 * # Every credential write is a compare-and-swap
 *
 * D3, and carry-forward ruling 73. This path reads the credential, spends ~40 ms
 * hashing, and then writes — the exact shape that made Task 9's H1, where a
 * value computed from a pre-hash read was written as an absolute. The write is
 * predicated on the hash that was read, and `count: 0` is a **refusal**: what is
 * stale is not the value but the decision to write it.
 *
 * # One refusal code, and a refusal never burns the link
 *
 * `TokenInvalidError` / `TOKEN_INVALID` covers unknown, expired, consumed,
 * superseded, a non-`ACTIVE` user (D4) and a lost compare-and-swap alike. A
 * distinguishable outcome is a thing a caller can learn by submitting values,
 * which is what turns a consume endpoint into an oracle. Every one of those
 * refusals **throws inside the transaction**, so the redemption rolls back and
 * the link still works — Task 8's `verify-email` set the pattern and the
 * argument is unchanged: burning a credential in exchange for nothing is the
 * unkinder half of a choice that has no security difference.
 *
 * # Mail after the commit, never inside it
 *
 * Carry-forward rulings 44 and 45. `AuthMailer` takes no transaction handle, and
 * every send below is after the `$transaction` has returned.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(BreachCheckService) private readonly breachCheck: BreachCheckService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(SessionService) private readonly sessions: SessionBulkRevoker,
  ) {}

  /**
   * Issues a reset link, or does not, and says the same thing either way.
   *
   * **Every path writes an audit row, including the one with no account.** That
   * is `security/audit.md` §3's rule and the same reasoning `LOGIN_FAILED`'s
   * unknown-address row carries: the wire response is identical by design, so
   * without the row a distributed sweep across addresses that are not customers
   * leaves no trace anywhere. The attempted address is **not** in the metadata —
   * `ip` and `requestId` already carry the signal that matters, and an
   * append-only table is the worst place to learn the address of somebody who is
   * not a customer.
   */
  async request(command: ForgotPasswordCommand): Promise<void> {
    const user = await this.store.user.findUnique({ where: { email: command.email } });

    if (user === null) {
      await this.store.$transaction(async (tx: IdentityTransaction) => {
        await this.audit.record(tx, {
          // `SYSTEM` with a null actor. This endpoint is unauthenticated, so
          // the caller may be anybody; naming somebody as the actor would be a
          // false statement in a table that cannot be corrected.
          actorType: 'SYSTEM',
          actorId: null,
          action: 'PASSWORD_RESET_REQUESTED',
          resourceType: 'User',
          // NAMES NOTHING, and the attempted address is not in the metadata
          // either. See the method docblock.
          resourceId: null,
          metadata: { knownAccount: false, linkSent: false },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });
      });
      return;
    }

    if (user.status !== ACTIVE_USER_STATUS) {
      // No link, and a row that says why. Carry-forward ruling 37 at the
      // request end: a reset is not the route back from an administrative
      // decision, and `reset-password` would refuse the link anyway (D4), so
      // sending one would be an email promising something that cannot happen.
      await this.store.$transaction(async (tx: IdentityTransaction) => {
        await this.audit.record(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'PASSWORD_RESET_REQUESTED',
          resourceType: 'User',
          resourceId: user.id,
          metadata: {
            knownAccount: true,
            linkSent: false,
            // Ours, from the column, never a caller-supplied string.
            userStatus: user.status,
          },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });
      });
      return;
    }

    const issued = await this.store.$transaction(async (tx: IdentityTransaction) => {
      // Supersedes this user's outstanding reset tokens under an advisory lock
      // before inserting (ruling 31), and since Task 8 the partial unique index
      // makes one-live-token-per-purpose the database's invariant as well. So
      // asking twice invalidates the first link by construction.
      const token = await this.tokens.issueInTransaction(tx, {
        userId: user.id,
        purpose: 'PASSWORD_RESET',
      });
      await this.audit.record(tx, {
        actorType: 'SYSTEM',
        actorId: null,
        action: 'PASSWORD_RESET_REQUESTED',
        resourceType: 'User',
        resourceId: user.id,
        // THE RAW TOKEN IS NOT HERE AND MUST NEVER BE. The row's id is a safe
        // correlation handle; the secret exists in the link and nowhere else.
        metadata: {
          knownAccount: true,
          linkSent: true,
          verificationTokenId: token.id,
          // Worth one boolean: a reset requested for an address that never
          // confirmed is the shape of somebody recovering an abandoned
          // registration, and it is also the shape of an attacker who seeded
          // the address themselves.
          emailVerified: user.emailVerifiedAt !== null,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
      return token;
    });

    // After the commit. Ruling 44.
    await this.mailer.sendPasswordReset({ to: user.email, token: issued.token });
  }

  /**
   * Redeems a reset link, replaces the credential, revokes every session and
   * sends the notice.
   *
   * The breach check runs **first**, before the token is spent. A 422 must not
   * cost the user their link: the check is off by default and fails open
   * (carry-forward ruling 28), so a refusal here is a refusal that *may* happen
   * rather than a guarantee, and making it burn a credential would be a poor
   * trade for a control that is not always on.
   *
   * The hash of the new password is computed **outside** the transaction. It is
   * ~40 ms of CPU at production parameters and holding a Postgres transaction
   * open across it would put every reset in contention with everything else
   * touching that user's rows.
   */
  async reset(command: ResetPasswordCommand): Promise<void> {
    if (await this.breachCheck.isBreached(command.password)) throw new PasswordBreachedError();

    const passwordHash = await this.passwords.hash(command.password);

    const completed = await this.store.$transaction(async (tx: IdentityTransaction) => {
      const consumed = await this.tokens.consumeInTransaction(tx, {
        token: command.token,
        purpose: 'PASSWORD_RESET',
      });
      // Unknown, expired, already used, superseded — one refusal for all four,
      // and the throw rolls this transaction back.
      if (consumed === null) throw new TokenInvalidError();

      const user = await tx.user.findUnique({ where: { id: consumed.userId } });
      // `null` is a database anomaly — the FK cascade deletes a user's tokens
      // with them — and fails closed rather than inventing an account.
      if (user === null) throw new TokenInvalidError();
      // D4. A reset token is not permission to sign in a non-ACTIVE account.
      // The throw rolls the redemption back, so the link is still live if an
      // administrator later unlocks the account.
      if (user.status !== ACTIVE_USER_STATUS) throw new TokenInvalidError();

      const existing = await tx.credential.findUnique({ where: { userId: user.id } });

      if (existing === null) {
        // A `User` with no `Credential` row is a real state: the row is a
        // separate table, `auth.enumeration.integration.spec.ts` produces one by
        // deleting it, and an SSO-only account will be one when Phase 11 lands.
        // Refusing would strand such an account permanently with `TOKEN_INVALID`
        // as the only explanation it could ever be given, so the reset SETS a
        // password rather than replacing one.
        //
        // There is no compare-and-swap to do here and none is needed: the
        // concurrency this endpoint actually has is two redemptions of one
        // token, and `consumeInTransaction`'s conditional `UPDATE` has already
        // arbitrated that — only one caller reaches this line. `Credential.userId`
        // is `@unique`, so if that reasoning were ever wrong the database
        // refuses the second insert rather than accepting it.
        await tx.credential.create({ data: { id: newId('crd'), userId: user.id, passwordHash } });
      } else {
        // D3. Predicated on the hash that was read, so a sibling password write
        // that committed while this request was hashing makes this a refusal
        // rather than a silent overwrite.
        const { count } = await tx.credential.updateMany({
          where: { userId: user.id, passwordHash: existing.passwordHash },
          data: { passwordHash },
        });
        // The same `TOKEN_INVALID` as every other refusal (§6's one-refusal
        // rule), and the throw rolls the redemption back so the link survives
        // and a retry — reading the credential afresh — succeeds.
        if (count === 0) throw new TokenInvalidError();
      }

      // Counted INSIDE the transaction that writes the credential, so the
      // number and the change it describes are one atomic fact
      // (`CLAUDE.md` rule 10). See the field name below for why it is not
      // called `sessionsRevoked`.
      const liveSessionsAtWrite = await tx.session.count({
        where: { userId: user.id, revokedAt: null },
      });

      await this.audit.record(tx, {
        // The actor really is the account owner: redeeming this link required a
        // 256-bit secret delivered to their own mailbox, which is the strongest
        // evidence this endpoint can have.
        actorType: 'USER',
        actorId: user.id,
        action: 'PASSWORD_RESET_COMPLETED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: {
          // NAMED FOR WHAT IT MEASURES. It is the number of sessions live at
          // the instant the new hash committed — not the number
          // `revokeAllForUser` goes on to report, because that call happens
          // after this transaction (D2's ordering) and will also revoke a
          // session created in between (ruling 51). Calling it `sessionsRevoked`
          // would be a false statement in an append-only table for the sake of a
          // tidier name.
          liveSessionsAtWrite,
          // Distinguishes "replaced a password" from "set the first one", which
          // is the difference between a routine reset and an account that had no
          // password credential at all.
          replacedExistingCredential: existing !== null,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      return { userId: user.id, email: user.email, occurredAt: consumed.consumedAt };
    });

    // AFTER THE COMMIT, AND THAT ORDERING IS D2. The new hash is durable before
    // a single session is revoked, so there is no window in which the old
    // password can mint a session that the revocation has already passed over.
    //
    // NO `exceptSessionId`: a reset revokes every session there is. The person
    // completing it is holding none — they arrived from a link in their mailbox —
    // and if somebody else is holding one, that is exactly the session being
    // taken away.
    await this.sessions.revokeAllForUser(completed.userId);

    // Ruling 44 again, and this is the message that makes an account takeover
    // visible to its victim. A failed send is swallowed by `AuthMailer`
    // (ruling 45): the credential is already replaced and the sessions already
    // revoked, so propagating would report failure for work that cannot be
    // taken back.
    await this.mailer.sendPasswordChanged({
      to: completed.email,
      occurredAt: completed.occurredAt,
      ip: command.ip,
    });
  }
}
