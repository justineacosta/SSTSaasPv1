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
 * test.
 *
 * **It gained `revoke` in Task 10's fix round, and the reason is H1.** Login
 * issues a session and then, if the credential it authenticated against has
 * moved underneath it, has to take that session back — see
 * `credentialStillCurrent` below. Nothing else here revokes: this is not a
 * general capability, it is the second half of one check.
 */
export interface SessionIssuer {
  issue(input: IssueSessionInput): Promise<IssuedSession>;
  revoke(sessionId: string): Promise<boolean>;
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
 * # What Task 10 added here, and it is Task 9's debt rather than an inheritance
 *
 * **The transparent rehash on a successful login now exists** — see
 * `rehashCredential`. ADR-0014 §48 names login as the caller, `verify` has
 * reported `needsRehash` since Task 3, and until Task 10 nothing acted on it.
 * It partially closes carry-forward ruling 24: it drains the population of
 * weaker hashes for every account that signs in, and an account that never
 * signs in again keeps its old hash indefinitely, which ADR-0014 §116 already
 * acknowledges.
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
    if (user.status !== ACTIVE_USER_STATUS) {
      await this.recordStatusDenial(user, command);
      throw new AccountLockedError();
    }

    // The credential facts travel INTO `succeed` rather than being acted on
    // afterwards, and that reordering is H1's. The rehash (D8) rewrites the
    // stored hash, and the post-issue check `succeed` now performs compares
    // against the hash in force — so the two have to happen in a known order,
    // in one place, or a rehashing login revokes itself. See `succeed`.
    return this.succeed(user, command, {
      verifiedHash: storedHash,
      needsRehash: verification.needsRehash,
    });
  }

  /**
   * D8. Replaces a credential stored at weaker parameters, transparently.
   *
   * # What this closes, and what it does not
   *
   * ADR-0014 §48 promises the upgrade happens "on next successful login".
   * `PasswordService.verify` has reported `needsRehash` since Task 3 and
   * nothing acted on it until now, which left **carry-forward ruling 24 open by
   * construction**: a pre-raise stored hash verifies at old, cheaper parameters
   * while an absent account verifies at current ones — measured at 35.9 ms
   * against 7.7 ms in Task 3 — so raising the parameters opens a timing oracle
   * pointing the opposite way from the one the dummy hash closes.
   *
   * This is the mechanism that **drains** that population, and it is a partial
   * close, stated plainly: an account whose owner never signs in again keeps
   * its old hash indefinitely, so the oracle narrows over time rather than
   * shutting. ADR-0014 §116 already acknowledges that, and nothing here changes
   * it. The population it does drain is every account that signs in.
   *
   * # It is a compare-and-swap, for D3's reason on a third path
   *
   * The write is decided from a hash read before a ~40 ms verification, so a
   * password change or reset that committed in between must not be overwritten.
   * Without the predicate this maintenance write would **reinstate the old
   * password's digest and silently undo a password change** — the same shape as
   * carry-forward ruling 73, on the one path where the write is not the point of
   * the request. `count: 0` means the credential moved and there is nothing to
   * upgrade; it is not an error.
   *
   * # It never changes the response and never fails the login
   *
   * ADR-0014's two constraints. The user authenticated successfully, and a
   * maintenance write is not permission to refuse them — so every failure is
   * swallowed and logged. It is logged at `warn` rather than silently, because
   * an operator who has just raised the parameters needs to be able to see that
   * the upgrade path is not draining anything; a silent failure here would make
   * ADR-0014's promise look kept while ruling 24's oracle stayed wide open.
   *
   * The line names the user id and **no fragment of the hash or the password**
   * (critical security rule 6). The thrown error's text can derive from neither:
   * this is a Prisma write failure, not an argon2 parse failure — but the
   * binding is kept narrow anyway, because that distinction is one refactor
   * away from being wrong.
   */
  private async rehashCredential(
    userId: string,
    verifiedHash: string,
    password: string,
  ): Promise<string | null> {
    try {
      const passwordHash = await this.passwords.hash(password);
      const { count } = await this.store.credential.updateMany({
        where: { userId, passwordHash: verifiedHash },
        data: { passwordHash },
      });
      if (count === 1) return passwordHash;
      if (count === 0) {
        // The credential moved under us — a change or reset committed while
        // this login was verifying. Not an error, and not something to retry:
        // whatever is stored now was written by a request that had a better
        // claim to it, and it was written at current parameters anyway.
        this.logger.debug(
          { userId },
          'credential rehash skipped: the stored credential changed during this login',
        );
      }
    } catch (error) {
      this.logger.warn(
        { userId, err: error },
        'credential rehash on login failed; this account keeps its weaker stored parameters',
      );
    }
    // `null` means "nothing was written", so the caller keeps comparing against
    // the hash it verified. Returning the attempted value here would tell H1's
    // check that a write happened when it did not.
    return null;
  }

  /**
   * H1. IS THE CREDENTIAL THIS REQUEST AUTHENTICATED WITH STILL THE ACCOUNT'S?
   *
   * Asked **after** `SessionService.issue` has returned, and that position is
   * the whole point. A password reset commits its new hash and then revokes
   * every session; `revokeLiveForUser` is one `updateMany` and cannot revoke a
   * row that does not exist yet, so a login whose credential read preceded the
   * reset's commit and whose `Session` insert follows the reset's revoke was
   * never swept. The reviewer measured **25 of 25** such logins surviving across
   * five rounds, each a fully privileged `ACTIVE` session answering
   * `GET /auth/session` with 200 for up to 30 days.
   *
   * **This closes it rather than narrowing it, and the argument is that there
   * are only two interleavings:**
   *
   * - the `Session` insert lands BEFORE the reset's revoke, and the revoke
   *   sweeps the row — the existing mechanism, which works;
   * - the insert lands AFTER the revoke, which means the reset's credential
   *   write committed before the insert, so this read observes it.
   *
   * There is no third ordering, because the reset writes the credential before
   * it revokes (D2) and this read happens after the insert.
   *
   * # It compares MEANING, not bytes, and that is not fussiness
   *
   * The naive form — compare the stored hash to the one this request read —
   * revokes a login whenever the row changed for **any** reason, and D8 gives it
   * two innocent reasons. This request's own rehash is handled by passing the
   * hash it wrote (see `succeed`); a **concurrent** login's rehash is not, and
   * would make two simultaneous sign-ins with the correct password refuse each
   * other for the lifetime of a parameter migration.
   *
   * So a mismatch is not the answer, it is the question: re-verify the password
   * against whatever is stored now. A rehash of the same password verifies and
   * the session stands; a reset or a change does not and the session goes.
   *
   * **Cost.** One indexed read on a `@unique` column per successful login, and
   * nothing else in the common case — the extra Argon2id verification is paid
   * only when the row actually moved, which is the rare case this exists for.
   *
   * `null` from the read is treated as "the credential is gone", which is a
   * reset that has not yet written or a deleted account; either way the session
   * this request just issued should not stand.
   */
  private async credentialStillCurrent(
    userId: string,
    hashInForce: string | null,
    password: string,
  ): Promise<boolean> {
    const current = await this.storedHashFor(userId);
    if (current === hashInForce) return true;
    if (current === null) return false;
    return (await this.passwords.verify(current, password)).valid;
  }

  /**
   * M2. THE DENIAL THAT WROTE NOTHING.
   *
   * `security/audit.md` §3 requires failures and denials to be audited, and
   * until the fix round this path produced a 403 and **zero** rows — measured
   * by the reviewer. It is the most investigation-relevant denial this endpoint
   * can produce: somebody is holding a **working credential** for an account an
   * operator deliberately switched off, and nothing anywhere recorded it.
   *
   * **The "do not let an unauthenticated caller grow the table" argument does
   * not reach here**, which is why this is written while an attempt during a
   * live brute-force lock still is not. Reaching this line costs the correct
   * password, so it is not a row anybody can produce at will — and unlike a
   * brute-force lock there is no `ACCOUNT_LOCKED` row already recording that
   * the state exists.
   *
   * **No state changes**, so there is nothing for the event to be atomic with.
   * The counter is deliberately untouched: the password was right, and the
   * refusal is about the account rather than about the attempt. A transaction is
   * still opened because `PlatformAuditService.record` writes through a handle
   * the caller passes in and never opens its own — `security/audit.md` §2's rule
   * expressed as a signature.
   *
   * `LOGIN_FAILED` rather than `ACCOUNT_LOCKED`: this codebase gives the latter
   * one meaning — *the failed attempt that tripped the per-account lock* — and
   * `platform-audit.actions.ts` and `audit.md` §4 both say so. Reusing it here
   * would make an administrative status and a brute-force lock indistinguishable
   * in the table, which is the opposite of what an investigation needs.
   * `metadata.userStatus` is what distinguishes this row, and
   * `metadata.passwordAccepted` is the fact worth reading it for.
   */
  private async recordStatusDenial(user: IdentityUserRow, command: LoginCommand): Promise<void> {
    await this.store.$transaction(async (tx: IdentityTransaction) => {
      await this.audit.record(tx, {
        // `SYSTEM` with a null actor, like every other failure row. The password
        // was right, but an account an operator switched off is exactly the case
        // where "the credential holder is the account owner" is the assumption
        // worth not making in an append-only table.
        actorType: 'SYSTEM',
        actorId: null,
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        resourceId: user.id,
        metadata: {
          knownAccount: true,
          // `ACTIVE | LOCKED | DISABLED`. Ours, from the column, never a
          // caller-supplied string.
          userStatus: user.status,
          passwordAccepted: true,
        },
        ip: command.ip,
        userAgent: command.userAgent,
        requestId: command.requestId,
      });
    });
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

    const counted = await this.store.$transaction(async (tx: IdentityTransaction) => {
      // THE COUNT IS THE DATABASE'S, NOT OURS. H1.
      //
      // The previous version computed `user.failedLoginCount + 1` from a row
      // read before a ~40 ms Argon2id verification and wrote it as an absolute
      // value. Five parallel wrong passwords therefore all wrote `1`: the
      // review measured the counter at 1, no lock, zero `ACCOUNT_LOCKED` rows,
      // zero burst notices, and a correct password immediately afterwards
      // answering 200. §7's brute-force control did not engage at all under the
      // one access pattern an attacker would actually choose, and every test in
      // both lanes was sequential, so the whole gate stayed green over it.
      //
      // `{ increment: 1 }` makes Postgres do the read-modify-write while it
      // holds the row lock, and the predicate makes the "no state change during
      // a live lock" rule hold there too — a racing attempt blocks, re-evaluates
      // against the committed row, and reports `count: 0`.
      const { count } = await tx.user.updateMany({
        where: { id: user.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
        data: { failedLoginCount: { increment: 1 } },
      });
      // Locked by a sibling request that committed while this one was hashing.
      // Nothing is written, audit row included — the same rule the pre-flight
      // check applies from the stale read, applied here where it is authoritative.
      if (count === 0) return null;

      // Safe inside this transaction and nowhere else: the `UPDATE` above holds
      // the row lock until commit, so no other transaction can move the counter
      // between that statement and this read.
      const updated = await tx.user.findUnique({ where: { id: user.id } });
      // Unreachable — the update above just matched this row. Handled rather
      // than asserted, because the alternative is a 500 on a failed login.
      if (updated === null) return null;

      const consecutiveFailures = updated.failedLoginCount;
      const lockedUntil = lockedUntilFor(consecutiveFailures, now);

      if (lockedUntil !== null) {
        // The lock alone. The counter is not restated: it is the value the
        // database chose one statement ago, and restating it is the defect.
        await tx.user.update({ where: { id: user.id }, data: { lockedUntil } });
      }

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

      return { consecutiveFailures, lockedUntil };
    });

    if (counted !== null && counted.lockedUntil !== null) {
      // ONCE PER LOCK, AND THE PREDICATE IS WHY. Exactly one transaction can
      // observe the count crossing the threshold, because every attempt that
      // arrives afterwards — including the four that raced this one and were
      // still hashing when it committed — re-evaluates the `updateMany`
      // predicate against the locked row and reports `count: 0`. Before H1 was
      // fixed this rested on the pre-flight `isLocked` read, which four
      // concurrent requests all pass; the integration lane measured five burst
      // notices from one burst. Sending per failure past the threshold
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
        attemptCount: counted.consecutiveFailures,
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
  private async succeed(
    user: IdentityUserRow,
    command: LoginCommand,
    credential: { verifiedHash: string | null; needsRehash: boolean },
  ): Promise<LoginResult> {
    const familiar = await this.isFamiliar(user.id, command);
    const mfaRequired = (await this.confirmedFactor(user.id)) !== null;
    const now = new Date();

    await this.store.$transaction(async (tx: IdentityTransaction) => {
      // UNDER THE SAME PREDICATE THE FAILURE PATH USES, AND FOR THE SAME
      // REASON. The pre-flight lock check ran before the hash; a burst can
      // commit a lock inside that window, and clearing `lockedUntil` from a
      // stale decision would erase it — admitting this login past a live lock
      // and leaving the sibling's `ACCOUNT_LOCKED` row describing an account
      // that is no longer locked. `security/authentication.md` §7's "an attempt
      // during a live lock changes no state" says attempt, not failed attempt.
      const { count } = await tx.user.updateMany({
        where: { id: user.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
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

      // The lock landed while this request was hashing. Throwing rolls the
      // transaction back, so no `LOGIN` row is written for a login that is not
      // happening, and the caller gets the 403 D3 specifies for a correct
      // password against a locked account. No audit row is added here: the
      // sibling that set the lock wrote `ACCOUNT_LOCKED` as it did so.
      if (count === 0) throw new AccountLockedError();

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

    // D8, AND IT RUNS BEFORE THE SESSION IS ISSUED SO THAT H1'S CHECK BELOW
    // KNOWS WHAT THE HASH IN FORCE IS.
    //
    // ADR-0014 §48's "rehashed transparently on next successful login", which
    // Task 9 shipped this endpoint without. It runs on BOTH arms — the
    // credential was proved correct, and whether a second factor is still owed
    // says nothing about the parameters it was stored at.
    //
    // It used to run in `login()` after `succeed()` returned. That was fine
    // until H1 added a post-issue comparison, at which point a rehash happening
    // afterwards would have been invisible to it and a rehash happening before
    // it would have looked like somebody else's write. Moving it here makes the
    // ordering explicit rather than incidental.
    let hashInForce = credential.verifiedHash;
    if (credential.needsRehash && credential.verifiedHash !== null) {
      const rehashed = await this.rehashCredential(
        user.id,
        credential.verifiedHash,
        command.password,
      );
      if (rehashed !== null) hashInForce = rehashed;
    }

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

    // H1. THE SESSION EXISTS; NOW CHECK THAT THE CREDENTIAL IT RESTS ON STILL
    // DOES. Before the MFA return, so both arms are covered — a `PENDING_MFA`
    // session minted from a password that has just been reset is the same
    // defect wearing a shorter clock.
    if (!(await this.credentialStillCurrent(user.id, hashInForce, command.password))) {
      await this.sessions.revoke(issued.session.id);
      // Not an audit row. The `LOGIN` row written above is a true statement —
      // the password WAS correct when it was verified — and a contradicting row
      // beside it would make the table harder to read rather than easier. What
      // an operator needs is the fact that a session was taken back, and that
      // is this line. No hash, no password, no fragment of either (critical
      // security rule 6).
      this.logger.warn(
        { userId: user.id, sessionId: issued.session.id },
        'credential changed while this login was in flight; the session it issued was revoked',
      );
      // The same refusal as every other login failure, byte for byte, so this
      // path discloses nothing that the others do not. It is also honest: the
      // credential this request authenticated with is no longer the account's.
      throw new InvalidCredentialsError();
    }

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
      // NO USER AGENT. H2: it is the signing-in party's chosen header, and on
      // the takeover path this message is going to somebody else. It is in the
      // `LOGIN` audit row written above, which is where attacker-supplied text
      // belongs. `AuthMailer.sendNewDeviceSignIn` has no parameter for it.
      await this.mailer.sendNewDeviceSignIn({
        to: user.email,
        occurredAt: now,
        ip: command.ip,
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
