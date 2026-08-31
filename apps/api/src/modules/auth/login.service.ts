import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@sentinel/observability';
import { LOGGER, PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AccountLockedError } from './account-locked.error.js';
import { AuthMailer } from './auth-mailer.js';
import type { IdentityStore, IdentityTransaction, IdentityUserRow } from './identity.store.js';
import { InvalidCredentialsError } from './invalid-credentials.error.js';
import { isLocked, lockedUntilFor } from './lockout.js';
import { PasswordService } from './password.service.js';
import type { AuthRequestContext } from './request-context.js';
import { SessionService, type IssuedSession, type IssueSessionInput } from './session.service.js';

/**
 * The only `UserStatus` that may hold a session.
 *
 * `UserStatus` is `ACTIVE | LOCKED | DISABLED` in `schema.prisma`. There is no
 * `SUSPENDED` arm; that value belongs to `OrganizationStatus`.
 * `email-verification.service.ts` holds the same constant for the same reason
 * (carry-forward ruling 37): nothing below the endpoint checks it.
 */
const ACTIVE_USER_STATUS = 'ACTIVE';

/**
 * The slice of `SessionService` login uses.
 *
 * The same narrow-port shape `AuthenticationGuard`'s `SessionResolver` uses,
 * and for the same reason: a service typed against the whole session machine is
 * a service whose every spec is either a mock of the world or an integration
 * test. Login issues and never resolves, rotates or revokes.
 */
export interface SessionIssuer {
  issue(input: IssueSessionInput): Promise<IssuedSession>;
}

export interface LoginCommand extends AuthRequestContext {
  /** Already normalised by `emailSchema` — trimmed and lower-cased. */
  readonly email: string;
  readonly password: string;
  /** D10, carry-forward ruling 18. Defaulted by the controller, not here. */
  readonly rememberMe: boolean;
}

/**
 * The two shapes `loginResponseSchema` publishes, before they become a body.
 *
 * A discriminated union rather than an object with an optional token, for the
 * contract's own reason: the optional version lets a caller forget to check the
 * discriminant and still typecheck, and the failure mode of that mistake is a
 * handler treating a half-authenticated login as complete.
 */
export type LoginResult =
  | {
      readonly kind: 'authenticated';
      /** The raw session token, for the cookie. Returned exactly once. */
      readonly token: string;
      readonly cookieMaxAgeSeconds: number | null;
    }
  | { readonly kind: 'mfa-required'; readonly pendingToken: string };

/**
 * `POST /api/v1/auth/login`.
 *
 * # The order of operations IS the design
 *
 * 1. Read the user (may be `null`).
 * 2. Read the credential, if there is a user.
 * 3. **Verify the password — always, on every path**, against the stored hash
 *    or against `PasswordService`'s dummy.
 * 4. *Then* consult the lock, the account status, and the MFA factor.
 *
 * Steps 3 and 4 are in that order and must stay in it. Consulting the lock
 * first would make a locked account answer measurably faster than an unlocked
 * one, which is an oracle for "this address is registered and somebody has been
 * guessing at it". Verifying first is also what makes D3 expressible at all:
 * `ACCOUNT_LOCKED` is returned only when the password was otherwise correct,
 * and that is not a question you can answer before you have asked it.
 *
 * # Both paths pay for Argon2id, and the absent account is not the cheap one
 *
 * Carry-forward ruling 21. `PasswordService.verify(storedHash: string | null,
 * password)` performs a full verification against a dummy built from live
 * parameters when the hash is `null`, and this service **calls it with `null`**
 * rather than branching around it. There is deliberately no
 * `if (user === null) throw` before the verification.
 *
 * **The residual, measured rather than implied.** The absent-account path skips
 * one indexed lookup on `Credential` — it has no `userId` to look one up by.
 * That is one index probe against a full Argon2id verification both paths pay,
 * the same trade `registration.service.ts` records and measures on its own two
 * paths. `login.service.spec.ts` asserts the skip explicitly so a reader can
 * see what the residual is instead of inferring that there is none.
 *
 * **And carry-forward ruling 24 is NOT closed here and this task did not touch
 * it.** Timing equality holds against the dummy at *current* Argon2 parameters
 * and not against hashes stored before a parameter raise — measured at 4.6x in
 * Task 3 — so the oracle opens on the day an operator raises them. It points
 * the opposite way from the one this path closes and it is inherited, open, and
 * out of scope.
 *
 * # A failed login WRITES, which is why it can be audited
 *
 * `security/audit.md` §3 requires failures and denials to be audited, and Task 8
 * could not satisfy it for a failed verification: the refusal throws, which
 * rolls back the transaction the event would live in. Login has no such excuse.
 * A failed login already writes — the counter increment — so the event goes in
 * the same transaction as the increment and commits with it (`CLAUDE.md` rule
 * 10). Every row is a `PlatformAuditEvent` (ruling 62, ADR-0019): a login has
 * no organisation, and `AuditEvent`'s RLS policy refuses the insert.
 *
 * **One exception, and it is a decision this service makes.** An attempt that
 * arrives while a lock is already live writes **nothing at all** — no counter
 * change, no lock extension, and no audit row. The state half is D2's rule and
 * is what stops the lock becoming the attack. The audit half follows from the
 * same argument: an unauthenticated caller must not be able to grow an
 * append-only table at will, one row per request, and the `ACCOUNT_LOCKED` row
 * already records that the lock happened. What it costs is the forensic record
 * of attempts *during* a lock; what it buys is a table an attacker cannot
 * inflate. Recorded in this task's report as a decision the brief did not make.
 *
 * # Mail after the commit, never inside it
 *
 * Carry-forward rulings 44 and 45. `AuthMailer` takes no transaction handle, so
 * putting a send inside one is awkward to write rather than easy to do by
 * accident, and every send below is after the `$transaction` has returned. A
 * failed send is swallowed by `AuthMailer` and never changes the response —
 * otherwise a mail-transport outcome would be observable as a different HTTP
 * answer for a locked account than for any other failure.
 *
 * # What Task 9 does not do here, stated rather than left to be found
 *
 * - **No new-device notice on the MFA arm.** "New sign-in to your Sentinel
 *   account" would be a false statement about a session that can do nothing but
 *   type a code. Task 11 owns the notice on MFA completion, and until it lands
 *   an MFA-enrolled account gets no unfamiliar-session notice at all. No
 *   account can hold a confirmed factor today, so nothing is currently missed.
 * - **No rehash on a successful login.** `PasswordService.verify` reports
 *   `needsRehash` and nothing here acts on it, so a credential stored at
 *   weaker parameters stays there. ADR-0014's "rehashed transparently on next
 *   successful login" is therefore still unimplemented; it is a write on the
 *   login path and belongs with Task 10, which already owns writing to
 *   `Credential`.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionIssuer,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async login(command: LoginCommand): Promise<LoginResult> {
    const user = await this.store.user.findUnique({ where: { email: command.email } });
    const storedHash = user === null ? null : await this.storedHashFor(user.id);

    // UNCONDITIONAL, AND BEFORE ANY DECISION. See the class docblock.
    const verification = await this.passwords.verify(storedHash, command.password);

    if (verification.credentialUnreadable && user !== null) {
      // CARRY-FORWARD RULING 25. An operational fault, not a failed login: this
      // row cannot be read by the algorithm that wrote it. The user id and
      // nothing else — no hash, no password, no fragment of either (critical
      // security rule 6) — and the caller's answer below is unchanged.
      //
      // Guarded on `user !== null` as belt and braces: `verify` already reports
      // `false` for the null path, and a signal here for an absent account
      // would put the existence distinction the dummy hash erases into a file
      // an operator reads.
      this.logger.error(
        { userId: user.id },
        'stored credential could not be read by argon2; the row is corrupt and this account cannot sign in',
      );
    }

    if (user === null) {
      await this.recordFailure(null, command);
      throw new InvalidCredentialsError();
    }

    const now = new Date();
    if (isLocked(user.lockedUntil, now)) {
      // NOTHING IS WRITTEN ON EITHER ARM. D2, and the audit half is this
      // service's own decision — see the class docblock.
      if (verification.valid) throw new AccountLockedError();
      throw new InvalidCredentialsError();
    }

    if (!verification.valid) {
      await this.recordFailure(user, command);
      throw new InvalidCredentialsError();
    }

    // The password is correct. The administrative lock is consulted only now,
    // for D3's reason exactly: a wrong password against a `LOCKED` account must
    // be indistinguishable from a wrong password against any other.
    if (user.status !== ACTIVE_USER_STATUS) throw new AccountLockedError();

    return this.succeed(user, command);
  }

  private async storedHashFor(userId: string): Promise<string | null> {
    const credential = await this.store.credential.findUnique({ where: { userId } });
    // `?? null` rather than an optional: a `User` with no `Credential` row is a
    // real state (an SSO-only account, once Phase 11 exists), and it must take
    // the same nullable-hash path an absent account takes rather than a cheaper
    // one of its own.
    return credential?.passwordHash ?? null;
  }

  /**
   * The failed-login write: the counter, the lock it implies, and the audit
   * row, as one transaction.
   *
   * `user === null` is the address-with-no-account case: there is no row to
   * increment, so the transaction carries the audit event alone. It still opens
   * one, because `PlatformAuditService.record` writes through a handle the
   * caller passes in and never opens its own — `security/audit.md` §2's rule
   * expressed as a signature.
   */
  private async recordFailure(user: IdentityUserRow | null, command: LoginCommand): Promise<void> {
    if (user === null) {
      await this.store.$transaction(async (tx: IdentityTransaction) => {
        await this.audit.record(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'LOGIN_FAILED',
          resourceType: 'User',
          // NAMES NOTHING, and the attempted address is not in the metadata
          // either. D5: the forensic signal that matters is "this IP failed
          // against N unknown addresses", which `ip` and `requestId` already
          // carry. The address belongs to somebody who is not a customer, and
          // an append-only table is the worst place to learn that. Precedent:
          // the rate limiter hashes the address before it becomes a Redis key.
          resourceId: null,
          metadata: { knownAccount: false, consecutiveFailures: 0 },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });
      });
      return;
    }

    const now = new Date();
    const consecutiveFailures = user.failedLoginCount + 1;
    const lockedUntil = lockedUntilFor(consecutiveFailures, now);

    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await tx.user.update({
        where: { id: user.id },
        // Both columns together. `IdentityUserUpdateData`'s union is what makes
        // "increment and forget the lock" unwritable rather than merely
        // discouraged.
        data: { failedLoginCount: consecutiveFailures, lockedUntil },
      });

      await this.audit.record(tx, {
        actorType: 'SYSTEM',
        // `SYSTEM` with a null actor, following
        // `registration.service.ts`'s `recordBlockedAttempt`: naming the
        // account owner as the actor of a failed login would be a false
        // statement in an append-only table, and the whole point of the row is
        // that it was probably not them.
        actorId: null,
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: { knownAccount: true, consecutiveFailures },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      if (lockedUntil !== null) {
        await this.audit.record(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'ACCOUNT_LOCKED',
          resourceType: 'User',
          resourceId: user.id,
          // The instant, because unlike the burst notice this row is read by an
          // operator rather than by the account owner, and "how long" is the
          // first question they will have.
          metadata: { consecutiveFailures, lockedUntil: lockedUntil.toISOString() },
          ip: command.ip,
          userAgent: command.userAgent,
          requestId: command.requestId,
        });
      }
    });

    if (lockedUntil !== null) {
      // ONCE PER LOCK. Every subsequent failure arrives while the lock is live
      // and returns above without reaching this method at all, so a cycle can
      // produce exactly one of these. Sending per failure past the threshold
      // would make the notice an outbound-email amplifier aimed at the victim,
      // triggered by an unauthenticated caller at will, and the fifth message
      // would tell them nothing the first did not.
      //
      // Sent for an UNVERIFIED address too, unlike the new-device notice. The
      // asymmetry is deliberate: this message renders no display name, no IP
      // and no user agent — nothing an attacker supplies can travel through it
      // — and the person who most needs to hear "somebody is guessing at your
      // account" is the one who has not finished setting it up.
      await this.mailer.sendFailedLoginBurst({
        to: user.email,
        occurredAt: now,
        attemptCount: consecutiveFailures,
      });
    }
  }

  /**
   * The accepted-password path.
   *
   * The familiarity question is asked **before** the session is issued, and
   * that ordering is the whole mechanism: the row this login is about to create
   * carries exactly this `(userId, ip, userAgent)` triple, so a lookup
   * afterwards matches itself, every login is familiar, and the notice never
   * fires again.
   */
  private async succeed(user: IdentityUserRow, command: LoginCommand): Promise<LoginResult> {
    const familiar = await this.isFamiliar(user.id, command);
    const mfaRequired = (await this.confirmedFactor(user.id)) !== null;
    const now = new Date();

    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await tx.user.update({
        where: { id: user.id },
        // `lastLoginAt` ONLY on the arm that issues a session which can do
        // something. A `PENDING_MFA` session is a few minutes of permission to
        // type six digits, and stamping "last login" for it would make the
        // column mean "last accepted password" — which is not what any reader
        // of it, `/settings/security` included, will assume. The counter and
        // the lock are cleared on both arms, because the password WAS correct
        // and a user with MFA who mistyped four times must not stay one failure
        // from a lock forever.
        data: mfaRequired
          ? { failedLoginCount: 0, lockedUntil: null }
          : { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      });

      await this.audit.record(tx, {
        // THE ONE ROW IN THIS SERVICE WHOSE ACTOR REALLY IS THE ACCOUNT OWNER.
        // They have just proved they hold the password.
        actorType: 'USER',
        actorId: user.id,
        action: 'LOGIN',
        resourceType: 'User',
        resourceId: user.id,
        // `mfaRequired` distinguishes "a password was accepted and a session
        // issued" from "a password was accepted and a second factor is owed",
        // which is a distinction an investigation needs and the action name
        // alone cannot carry. `newDevice` is ours, computed below.
        metadata: { mfaRequired, newDevice: !familiar },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });

    // AFTER THE COMMIT, and that ordering matters here for a reason beyond
    // ruling 44's: a session minted inside a transaction that then rolls back
    // survives in Redis and in the caller's hand, and there is no row anywhere
    // saying it was issued.
    const issued = await this.sessions.issue({
      userId: user.id,
      // Stated explicitly, both arms. Carry-forward ruling 6: `Session.status`
      // has no `@default` and `issueSessionInputSchema` has none either, so
      // forgetting it is a compile error rather than a silently privileged
      // session — and this is the call site where getting it wrong would BE the
      // MFA bypass.
      status: mfaRequired ? 'PENDING_MFA' : 'ACTIVE',
      // Omitted on the pending arm rather than passed as `false`:
      // `absoluteLifetimeSeconds` ignores it for a `PENDING_MFA` session
      // anyway, and passing a user preference into a call that discards it
      // invites a later reader to make it stop being discarded.
      ...(mfaRequired ? {} : { rememberMe: command.rememberMe }),
      // D9: no evidence has been presented, so there is none to carry.
      mfaCompletedAt: null,
      ip: command.ip,
      userAgent: command.userAgent,
    });

    if (mfaRequired) {
      // NO COOKIE. The controller returns this token in the body, per
      // `loginResponseSchema`'s second arm, and sets no `Set-Cookie` at all —
      // see `auth.controller.ts` for what is and is not currently reachable
      // with it.
      return { kind: 'mfa-required', pendingToken: issued.token };
    }

    if (!familiar && user.emailVerifiedAt !== null) {
      // ONLY TO A PROVEN ADDRESS. Ruling 70's rule applied at the caller: the
      // template carries no display name so there is nothing to inject, but a
      // branded security notice sent to an address nobody has proven belongs to
      // the account owner is still a message about somebody's account sent to
      // somebody who may not be them.
      await this.mailer.sendNewDeviceSignIn({
        to: user.email,
        occurredAt: now,
        ip: command.ip,
        userAgent: command.userAgent,
      });
    }

    return {
      kind: 'authenticated',
      token: issued.token,
      cookieMaxAgeSeconds: issued.cookieMaxAgeSeconds,
    };
  }

  /**
   * "UNFAMILIAR", DEFINED NARROWLY AND HONESTLY, AND THIS IS THE WHOLE
   * DEFINITION.
   *
   * A session is familiar when this user has held **any** session — live or
   * revoked — carrying the exact same `ip` and `userAgent`. That is one
   * `Session.findFirst` with `{ userId, ip, userAgent }`, served by the
   * `@@index([userId, lastSeenAt(sort: Desc)])` prefix on `userId` with the
   * other two as a filter. **Cost: one indexed read per successful login**,
   * bounded by how many sessions one person has ever held.
   *
   * `revokedAt` is deliberately absent from the predicate. A user who signed
   * out from this laptop yesterday holds no live session from it, and a notice
   * on every sign-in after a sign-out is noise that teaches the recipient to
   * ignore the one that matters.
   *
   * # What it does NOT prove, and this half matters more
   *
   * - **It is not device identity.** A user agent is a header the client
   *   chooses; an attacker who has the password can copy the victim's and
   *   suppress the notice entirely by guessing one popular string. No
   *   fingerprinting scheme was invented here, deliberately — the brief left
   *   the definition to this task and a scheme that *looks* like device
   *   identity is worse than one that admits it is not.
   * - **It is exact-match on both fields.** A browser minor-version bump
   *   changes the user agent, and a mobile network changes the IP between
   *   requests, so a real user will get this notice more often than "new
   *   device" suggests. That is the fail-safe direction — a false positive
   *   costs an email, a false negative costs the notice that would have
   *   revealed a takeover — but it is a real cost and it is why the message
   *   says "a device we have not seen before" rather than making a claim.
   * - **The first login of a new account is always unfamiliar**, because there
   *   are no prior sessions. That message is sent, and it is correct: it is the
   *   account owner's first sign-in and the notice is a true statement about
   *   it.
   *
   * A `null` `ip` or `userAgent` matches other rows that also recorded `null`,
   * which is what the Prisma predicate does with `null` and is the honest
   * reading: "we did not record it" twice is not evidence of a new device.
   */
  private async isFamiliar(userId: string, command: LoginCommand): Promise<boolean> {
    const prior = await this.store.session.findFirst({
      where: { userId, ip: command.ip, userAgent: command.userAgent },
      select: { id: true },
    });
    return prior !== null;
  }

  /**
   * D9. Looks for a **confirmed** factor and reads nothing but its id.
   *
   * No account can hold one today — there is no enrolment endpoint until Task
   * 11 — and login must still refuse to issue an `ACTIVE` session when one
   * exists, or Task 11 lands on top of a latent MFA bypass that no test would
   * have caught because no fixture could reach it.
   *
   * `confirmedAt: { not: null }` is load-bearing: carry-forward ruling 7
   * records that an *unconfirmed* factor occupies the `(userId, type)` unique
   * slot, so an abandoned enrolment is a row that exists. Gating a login on it
   * would lock a user out of their own account behind a code nobody has.
   */
  private async confirmedFactor(userId: string): Promise<{ id: string } | null> {
    return this.store.mfaFactor.findFirst({
      where: { userId, confirmedAt: { not: null } },
      select: { id: true },
    });
  }
}
