import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../../infrastructure/tokens.js';
import { PlatformAuditService } from '../audit/platform-audit.service.js';
import { AuthMailer } from './auth-mailer.js';
import { BreachCheckService } from './breach-check.service.js';
import type { IdentityStore, IdentityTransaction } from './identity.store.js';
import { InvalidCredentialsError } from './invalid-credentials.error.js';
import { PasswordBreachedError } from './password-breached.error.js';
import { PasswordService } from './password.service.js';
import type { AuthRequestContext } from './request-context.js';
import { SessionService } from './session.service.js';
import { LOCKOUT_THRESHOLD } from './lockout.js';

/**
 * How long a run of refused current-password attempts counts as one burst, and
 * how many of them earn the owner a message. M3.
 *
 * Both match `login`'s per-account window and its lockout threshold, and that
 * is the point rather than a coincidence: the two endpoints both refuse a
 * password, and an account owner should not have to learn two different stories
 * about what "somebody is guessing at your account" means.
 *
 * The window is counted over `PlatformAuditEvent` rows rather than a column,
 * so nothing here can move `User.failedLoginCount` — see the notice's own
 * docblock for why that separation is the whole design.
 */
const BURST_WINDOW_SECONDS = 900;
const BURST_THRESHOLD = LOCKOUT_THRESHOLD;

/**
 * The slice of `SessionService` a password change uses.
 *
 * The same narrow-port shape `SessionIssuer`, `SessionRevoker` and
 * `SessionBulkRevoker` take, for the same reason. A change revokes in bulk and
 * rotates exactly one session; it never issues or resolves.
 */
export interface SessionRotatingRevoker {
  revokeAllForUser(
    userId: string,
    options?: { exceptSessionId?: string | undefined },
  ): Promise<number>;
  rotate(input: {
    sessionId: string;
    status: 'ACTIVE';
  }): Promise<{ token: string; cookieMaxAgeSeconds: number | null } | null>;
}

export interface ChangePasswordCommand extends AuthRequestContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ChangePasswordResult {
  /**
   * The rotated session's raw token, for the replacement cookie — or `null`
   * when there was nothing left to rotate.
   *
   * `null` is not an error. The password has already been changed by the time
   * rotation is attempted, so a caller whose session was concurrently revoked
   * gets the change they asked for and no replacement cookie; the controller
   * clears the ones they hold, which signs them out rather than leaving a dead
   * cookie in the browser.
   */
  readonly token: string | null;
  readonly cookieMaxAgeSeconds: number | null;
}

/**
 * `POST /api/v1/auth/change-password`.
 *
 * # The order of operations IS the design
 *
 * 1. Read the stored credential (may be `null`).
 * 2. **Verify the current password — always, on every path**, against the
 *    stored hash or against `PasswordService`'s dummy.
 * 3. *Then* breach-check the new password.
 * 4. Hash the new password, outside any transaction.
 * 5. Write it under a compare-and-swap, with the audit row, as one transaction.
 * 6. *After the commit*, revoke every other session, then rotate the one in
 *    hand.
 *
 * **Step 2 before step 3, and that is a security ordering rather than a
 * stylistic one.** Breach-checking first would answer 422 to a caller who has
 * not proved the current password — telling somebody holding a stolen session
 * that the password they typed appears in a breach corpus, before they have
 * shown they may ask this account anything at all.
 *
 * **Carry-forward ruling 21 applies here as much as on login.**
 * `PasswordService.verify(storedHash: string | null, password)` performs a full
 * Argon2id verification against a per-process dummy when the hash is `null`, and
 * this service calls it with `null` rather than branching around it. An account
 * with no `Credential` row therefore costs the same and answers the same 401.
 *
 * # This endpoint is a credential-guessing oracle, and the rate limit is the
 * control
 *
 * The account is fixed by the session cookie, the answer is a clean 401/200
 * split, and **nothing on this path touches `User.failedLoginCount` or the
 * lockout ladder** — those live on the login path and this endpoint reaches
 * neither. What bounds guessing is `passwordChange`, 10/hour per IP, fail
 * closed; `security/abuse-prevention.md` §1 carries the reasoning and names the
 * per-principal half that would be the right key and resolves nothing today.
 *
 * Deliberately NOT wired into the lockout ladder: a caller who can lock an
 * account by failing here is a caller who can lock it with a stolen session,
 * and the ladder's own refusal (`ACCOUNT_LOCKED`, 403) would then be a
 * distinguishable outcome on an authenticated route. The audit row is the
 * signal instead, and `PASSWORD_CHANGE_FAILED` exists for exactly that.
 *
 * # Every write is decided from a row read before a ~40 ms hash
 *
 * D3, carry-forward ruling 73. Two concurrent change-password requests both
 * verify against the same old hash; without a predicate on that hash both
 * commit and the account's password is whichever request happened to land last,
 * with no error anywhere. The write is a compare-and-swap and `count: 0` is a
 * refusal.
 *
 * # The hash is committed before anything is revoked
 *
 * D2. `SessionService.revokeAllForUser`'s docblock names this as Task 10's:
 * a revoke-then-write ordering leaves a window in which the old password still
 * mints sessions the revocation has already passed over.
 *
 * **Every OTHER session, and the caller's own is rotated rather than killed.**
 * Losing your own session on a password change is a usability bug; keeping
 * every other one is a security bug — the whole point of the revocation is to
 * evict somebody who should not be there. `security/authentication.md` §3 lists
 * a password change as a privilege change, so the rotation is required rather
 * than cosmetic: the token in the browser before the change cannot be used
 * after it.
 */
@Injectable()
export class PasswordChangeService {
  constructor(
    @Inject(PRISMA) private readonly store: IdentityStore,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(BreachCheckService) private readonly breachCheck: BreachCheckService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
    @Inject(SessionService) private readonly sessions: SessionRotatingRevoker,
  ) {}

  async change(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    const stored = await this.store.credential.findUnique({ where: { userId: command.userId } });
    // `?? null` rather than an optional: a `User` with no `Credential` row is a
    // real state, and it must take the same nullable-hash path an absent
    // account takes on login rather than a cheaper one of its own.
    const storedHash = stored?.passwordHash ?? null;

    // UNCONDITIONAL, AND BEFORE ANY DECISION. Ruling 21.
    const verification = await this.passwords.verify(storedHash, command.currentPassword);
    if (!verification.valid) {
      await this.recordDenial(command, 'WRONG_CURRENT_PASSWORD');
      throw new InvalidCredentialsError();
    }

    // Only now. See the class docblock: a 422 before the current password is
    // proved is an oracle handed to whoever is holding a stolen session.
    if (await this.breachCheck.isBreached(command.newPassword)) throw new PasswordBreachedError();

    // Outside the transaction: ~40 ms of CPU at production parameters, and
    // holding a Postgres transaction open across it puts every password change
    // in contention with everything else touching this user's rows.
    const passwordHash = await this.passwords.hash(command.newPassword);

    const changed = await this.store.$transaction(async (tx: IdentityTransaction) => {
      // D3. Predicated on the hash the verification above ran against, so a
      // sibling change that committed while this request was hashing makes this
      // a refusal rather than a silent overwrite of whoever committed first.
      //
      // `storedHash` cannot be `null` here: a `null` stored hash makes
      // `verify` report `valid: false` (it runs against the dummy and discards
      // the result), and that path threw above. Narrowed rather than asserted,
      // because a non-null assertion here would be load-bearing and invisible.
      if (storedHash === null) throw new InvalidCredentialsError();

      const { count } = await tx.credential.updateMany({
        where: { userId: command.userId, passwordHash: storedHash },
        data: { passwordHash },
      });
      // `INVALID_CREDENTIALS`, and it is the honest answer rather than a
      // convenient one: after a sibling's change committed, the password this
      // caller proved a moment ago is genuinely no longer the current password.
      // The throw rolls the transaction back, so nothing is half-written.
      if (count === 0) throw new InvalidCredentialsError();

      // Counted INSIDE the transaction that writes the credential, so the
      // number and the change it describes are one atomic fact (rule 10). The
      // caller's own session is excluded because it is not revoked — it is
      // rotated, below.
      const liveSessionsAtWrite = await tx.session.count({
        where: { userId: command.userId, revokedAt: null, id: { not: command.sessionId } },
      });

      await this.audit.record(tx, {
        // THE ACTOR REALLY IS THE ACCOUNT OWNER. They presented a live session
        // cookie, the CSRF token derived from it, and the existing password —
        // more evidence than any other row this module writes.
        actorType: 'USER',
        actorId: command.userId,
        action: 'PASSWORD_CHANGED',
        resourceType: 'User',
        resourceId: command.userId,
        metadata: {
          // NAMED FOR WHAT IT MEASURES, not for the revocation that follows it.
          // See `password-reset.service.ts` for the full argument: the
          // revocation runs after this transaction by D2's ordering, and its
          // own count can differ. A tidier name would be a false statement in
          // an append-only table.
          liveSessionsAtWrite,
          // L1. `ownSessionRotated: true` USED TO BE HERE, AND IT WAS A
          // PREDICTION RATHER THAN A FACT.
          //
          // It was written inside this transaction, before `sessions.rotate()`
          // was called — and `rotate` returns `null` when the caller's session
          // was concurrently revoked, a case this service has a shipped test
          // for. The reviewer logged the metadata in exactly that test and got
          // `ownSessionRotated: true` with nothing rotated: one false fact in an
          // append-only table, in the rarest and most interesting case.
          //
          // It is removed rather than corrected, because there is nothing true
          // to write here: the rotation has not happened yet and this row cannot
          // be updated afterwards. Nothing is lost — `PASSWORD_CHANGED` and
          // `PASSWORD_RESET_COMPLETED` already distinguish the two credential
          // replacements, which is all the boolean ever carried.
          //
          // This is the same rule the field above is named for, applied one
          // field over: write what happened, not what was intended.
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      const user = await tx.user.findUnique({ where: { id: command.userId } });
      return { email: user?.email ?? null };
    });

    // AFTER THE COMMIT, AND THAT ORDERING IS D2.
    //
    // Every session EXCEPT the caller's own. Then the caller's own is rotated,
    // in that order, so at no instant is there a live session other than the one
    // being carried through the change.
    await this.sessions.revokeAllForUser(command.userId, { exceptSessionId: command.sessionId });

    // `status: 'ACTIVE'` stated explicitly — carry-forward ruling 6, and ruling
    // 50 one layer up. It is correct here because `AuthenticationGuard` refuses
    // a `PENDING_MFA` session on any handler that does not carry
    // `@AllowPendingMfa()`, and this one does not; if that ever stops being
    // true, `SessionService.rotate` throws `MFA_EVIDENCE_REQUIRED` rather than
    // quietly promoting the session, which is the loud failure that docblock
    // asks for.
    const rotated = await this.sessions.rotate({ sessionId: command.sessionId, status: 'ACTIVE' });

    if (changed.email !== null) {
      // Ruling 44: after the commit, never inside it. A failed send is
      // swallowed by `AuthMailer` (ruling 45) — the credential is already
      // replaced and the sessions already revoked, so propagating would report
      // failure for work that cannot be taken back.
      await this.mailer.sendPasswordChanged({
        to: changed.email,
        occurredAt: new Date(),
        ip: command.ip,
      });
    }

    return {
      token: rotated?.token ?? null,
      cookieMaxAgeSeconds: rotated?.cookieMaxAgeSeconds ?? null,
    };
  }

  /**
   * The denial row `security/audit.md` §3 requires, and Task 9's M2 is why it
   * is here rather than assumed.
   *
   * **No state changes**, so there is nothing for the event to be atomic with.
   * A transaction is still opened because `PlatformAuditService.record` writes
   * through a handle the caller passes in and never opens its own —
   * `security/audit.md` §2's rule expressed as a signature.
   *
   * The failure counter is deliberately untouched. See the class docblock: this
   * endpoint is not wired into the lockout ladder, because a caller who could
   * lock an account by failing here could lock it with a stolen session, and
   * the ladder's `ACCOUNT_LOCKED` refusal would become a distinguishable
   * outcome on an authenticated route.
   */
  private async recordDenial(command: ChangePasswordCommand, reason: string): Promise<void> {
    const notify = await this.store.$transaction(async (tx: IdentityTransaction) => {
      await this.audit.record(tx, {
        // `SYSTEM` with a null actor, following every other failure row in this
        // module. Somebody holding this session could not produce the password,
        // which is exactly why naming the account owner as the actor would be a
        // false statement in a table that cannot be corrected.
        actorType: 'SYSTEM',
        actorId: null,
        action: 'PASSWORD_CHANGE_FAILED',
        resourceType: 'User',
        // The ACCOUNT is named. Unlike a failed login against an unknown
        // address there is no question of who this is about: the session guard
        // has already resolved the principal.
        resourceId: command.userId,
        // Ours, never a caller-supplied string, and neither password nor any
        // fragment of either hash (critical security rule 6).
        metadata: { reason },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });

      // M3. COUNTED AFTER THE ROW IS WRITTEN, so the attempt that trips the
      // threshold is included in its own count — the same arithmetic
      // `login`'s ladder uses, where the fifth failure is the one that acts.
      //
      // **CONSECUTIVE, NOT MERELY RECENT, AND THE DIFFERENCE IS NOT COSMETIC.**
      // The first cut of this counted every failure in a fifteen-minute window
      // and a test caught it: a user who mistypes four times, succeeds, and then
      // mistypes once more would have been told somebody was guessing at their
      // account. Failures are counted from the later of the window's start and
      // the most recent successful change, so a success resets the run exactly
      // as it does on `login`'s ladder.
      const windowStart = new Date(Date.now() - BURST_WINDOW_SECONDS * 1000);
      const lastSuccess = await tx.platformAuditEvent.findFirst({
        where: { action: 'PASSWORD_CHANGED', resourceId: command.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const since =
        lastSuccess !== null && lastSuccess.createdAt > windowStart
          ? lastSuccess.createdAt
          : windowStart;
      const failures = await tx.platformAuditEvent.count({
        where: {
          action: 'PASSWORD_CHANGE_FAILED',
          resourceId: command.userId,
          createdAt: { gt: since },
        },
      });

      // ONCE PER BURST, NOT ONCE PER FAILURE PAST IT. Exactly equal, not `>=`:
      // the sixth and seventh attempts tell the recipient nothing the fifth did
      // not, and a message per failure would make this notice an outbound-email
      // amplifier aimed at the account owner, triggered at will by whoever holds
      // the session. The same rule `login`'s burst notice follows.
      if (failures !== BURST_THRESHOLD) return null;

      const user = await tx.user.findUnique({ where: { id: command.userId } });
      return user === null ? null : { email: user.email, attemptCount: failures };
    });

    if (notify === null) return;

    // AFTER THE COMMIT (ruling 44), and before the refusal is thrown — the
    // caller's answer is unchanged either way, because `AuthMailer` swallows a
    // send failure and the thrown error is the same `INVALID_CREDENTIALS` on
    // every path.
    //
    // **This is carry-forward ruling 78's residual on a third endpoint, and it
    // is accepted rather than closed.** The fifth refused attempt pays an SMTP
    // round trip that the first four do not, so the latency distinguishes them
    // even though the response does not. It is not closable before the Phase 4
    // queue, for the same reason `login`'s burst notice is not: the difference
    // is a real send on the response path. Reaching it costs five refused
    // attempts against one account by somebody already holding a session, which
    // is a narrower oracle than the one on `forgot-password`.
    await this.mailer.sendFailedLoginBurst({
      to: notify.email,
      occurredAt: new Date(),
      attemptCount: notify.attemptCount,
    });
  }
}
