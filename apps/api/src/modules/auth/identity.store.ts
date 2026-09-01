import type {
  PlatformAuditEventDelegate,
  PlatformAuditTransaction,
} from '../audit/platform-audit.service.js';
import type { VerificationTokenTransaction } from './token.service.js';

/**
 * THE NARROW PRISMA PORT THE REGISTRATION, VERIFICATION AND LOGIN SERVICES SEE.
 *
 * The same shape `TokenService`'s `VerificationTokenStore` and
 * `HealthService`'s `DatabaseProbe` use, and for the same reason: a service
 * typed against the whole `PrismaClient` makes every spec that touches it
 * either a mock of the world or an integration test. What is written out here
 * is exactly the tables and operations these three services perform, which is
 * also a readable inventory of everything the unauthenticated surface touches.
 *
 * The transaction type extends `VerificationTokenTransaction` and
 * `PlatformAuditTransaction`, which is what lets one `$transaction` carry the
 * user, the credential, the verification token and the audit event —
 * `security/audit.md` §2's "in the same transaction as the change".
 */

/**
 * The `User` columns these services read. **Nothing selects a password hash**;
 * that is `IdentityCredentialDelegate` below, and it is a separate read for a
 * reason — a row shape that carries a credential is a row shape somebody
 * eventually spreads into a log line.
 *
 * `failedLoginCount` and `lockedUntil` arrive with Task 9. They sit on the user
 * row rather than in a separate read because the login path already reads this
 * row and the lock decision needs both — and because `schema.prisma` records
 * that `lockedUntil` is the temporary automatic lock while `status = LOCKED` is
 * the separate administrative one, so a caller reading only `status` misses
 * every brute-force lock.
 */
export interface IdentityUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly emailVerifiedAt: Date | null;
  /** `UserStatus` — `ACTIVE`, `LOCKED` or `DISABLED`. */
  readonly status: string;
  /** Consecutive failed logins. Reset to 0 only by a successful login. */
  readonly failedLoginCount: number;
  /** The temporary, automatic brute-force lock. Clears itself; see `lockout.ts`. */
  readonly lockedUntil: Date | null;
}

export interface IdentityUserDelegate {
  findUnique(args: { where: { email: string } | { id: string } }): Promise<IdentityUserRow | null>;
}

/**
 * The shapes a `user.update` inside one of these transactions may carry.
 *
 * A union rather than a `Partial`, and that is carry-forward ruling 6's habit
 * applied one layer up: each arm is a complete statement of one operation, so a
 * caller cannot write "increment the counter" and silently forget the lock, or
 * stamp `lastLoginAt` without clearing the counter beside it. A partial would
 * make all three of those a valid call, and two of them are defects.
 */
export type IdentityUserUpdateData =
  /** Email verification (Task 8). */
  | { readonly emailVerifiedAt: Date }
  /**
   * The lock a failure has just earned (Task 9, H1).
   *
   * On its own, and deliberately **not** beside a `failedLoginCount`. The
   * count is no longer computed by the application: it is produced by the
   * atomic increment in `updateMany` below and read back inside the same
   * transaction, so a statement that wrote both would have to restate a value
   * the database had just chosen — which is exactly how H1 happened.
   */
  | { readonly lockedUntil: Date }
  /**
   * A successful login (Task 9). The counter and the lock are cleared in the
   * same statement that stamps `lastLoginAt`, so there is no instant at which
   * an account is signed in and still counted as failing.
   *
   * An absolute value is correct here: a successful login sets the counter to a
   * constant rather than deriving it from a value it read earlier.
   *
   * **What a concurrent request makes stale is not the value but the decision
   * to write it** — N-3, and the sentence that used to sit here said the
   * opposite. The pre-flight lock check runs before the ~40 ms hash, so a burst
   * can commit a lock inside that window; writing `lockedUntil: null` from that
   * stale decision erased a lock a sibling had just committed. Measured four
   * runs out of four. Both success arms are therefore written through
   * `updateMany` under the not-locked predicate, exactly like the failure arm,
   * and the shapes remain here because it is the *statement* that is
   * conditional, not the values.
   */
  | { readonly failedLoginCount: 0; readonly lockedUntil: null; readonly lastLoginAt: Date }
  /**
   * The MFA arm of a successful login: the counter and the lock clear, and
   * `lastLoginAt` is deliberately not stamped for a session that can do
   * nothing but complete MFA.
   *
   * **A completed password reset for an already-confirmed account writes this
   * same shape** (Task 10 fix round, L7), and it is the same statement: the
   * ladder's temporary lock clears and no sign-in is recorded.
   * `User.lockedUntil` is independent of `User.status`, so before that fix an
   * account could complete a reset and still be refused at `login` with
   * `ACCOUNT_LOCKED` while holding the correct new password — the failure mode
   * reset exists to fix, inflicted on somebody who has just proved mailbox
   * control. The counter clears with it so the account is not left one mistype
   * from a fresh lock the moment it is recovered.
   */
  | { readonly failedLoginCount: 0; readonly lockedUntil: null }
  /**
   * A completed password reset for an account that had **never confirmed its
   * address** (Task 10 fix round, L5 and L7).
   *
   * Redeeming a reset link is proof of mailbox control — it is the stated
   * reason such an account is sent one at all — and that is the same evidence
   * `emailVerifiedAt` carries. Before this the account completed a reset and
   * stayed unverified, so it went on being excluded from everything
   * verification gates, including the unfamiliar-sign-in notice.
   */
  | {
      readonly failedLoginCount: 0;
      readonly lockedUntil: null;
      readonly emailVerifiedAt: Date;
    };

/**
 * THE PREDICATE THAT MAKES THE FAILURE COUNTER SURVIVE CONCURRENCY. H1.
 *
 * The condition is "this account is not currently locked", evaluated by
 * Postgres while it holds the row lock rather than by the application from a
 * row it read ~40 ms earlier, on the far side of an Argon2id verification.
 * Under READ COMMITTED a second transaction blocks on the first's row lock and
 * then **re-evaluates this predicate against the committed version** — so an
 * attempt that raced the one which tripped the lock reports `count: 0` and
 * changes nothing. That is `security/authentication.md` §7's "an attempt during
 * a live lock changes no state" enforced where it can actually hold, instead of
 * from a read that is stale by construction.
 *
 * `lte` rather than `lt` mirrors `isLocked` in `lockout.ts`, which is strictly
 * greater-than: the two have to agree about the instant a lock ends, or a
 * request can be refused by one and admitted by the other.
 */
export interface IdentityUserFailureWhere {
  readonly id: string;
  readonly OR: readonly [{ readonly lockedUntil: null }, { readonly lockedUntil: { lte: Date } }];
}

export interface IdentityTransaction
  extends VerificationTokenTransaction, PlatformAuditTransaction {
  /**
   * The audit table, WRITE-ONLY except for one count. M3.
   *
   * `PasswordChangeService` needs to know how many times this account's current
   * password has been refused recently, so it can notify the owner on a burst —
   * and it must do that **without** touching `User.failedLoginCount`, because a
   * session thief who could move that counter could lock the owner out of
   * `login` outright. The append-only table it already writes to is the only
   * other place that fact exists, so it is counted from there rather than from
   * a new column: no migration, and no second source of truth to disagree with
   * the audit trail.
   *
   * Deliberately a COUNT and not a list. Nothing here needs the rows.
   */
  platformAuditEvent: PlatformAuditEventDelegate & {
    count(args: {
      where: {
        action: string;
        resourceId: string;
        /**
         * STRICTLY AFTER, not at-or-after. The boundary is usually the instant
         * of the last successful change, and that row's own timestamp must not
         * be able to drag the failures that preceded it into the count when two
         * rows land in the same tick.
         */
        createdAt: { gt: Date };
      };
    }): Promise<number>;
    /**
     * The most recent row of one action for one account, for the timestamp
     * alone.
     *
     * This is what makes the burst count **consecutive** rather than merely
     * recent: failures are counted from the last successful change, so a user
     * who mistyped four times, succeeded, and then mistyped four more does not
     * get a notice about a burst that never happened. `login`'s ladder has the
     * same property — only a success resets it — and an account owner should
     * not have to learn two different stories about what a burst means.
     */
    findFirst(args: {
      where: { action: string; resourceId: string };
      orderBy: { createdAt: 'desc' };
      select: { createdAt: true };
    }): Promise<{ readonly createdAt: Date } | null>;
  };
  user: IdentityUserDelegate & {
    create(args: { data: { id: string; email: string; name: string | null } }): Promise<unknown>;
    update(args: { where: { id: string }; data: IdentityUserUpdateData }): Promise<unknown>;
    /**
     * **Every write the login path makes to `User`, gated on the same
     * predicate**, because every one of them is decided from a row read on the
     * far side of a ~40 ms hash.
     *
     * The failure arm is only ever `{ increment: 1 }`: the type admits no
     * absolute value, because an absolute value derived from an earlier read is
     * the H1 defect, and this is the one column on `User` that two requests
     * routinely write at the same instant.
     *
     * The success arms carry absolute values, which is correct — a successful
     * login sets the counter to a constant rather than deriving it from
     * anything — but they are conditional for a different reason: what is stale
     * is not the value but the **decision to write it**. A correct password
     * racing the burst that locked the account would otherwise clear
     * `lockedUntil` and erase a lock a sibling had just committed, leaving the
     * `ACCOUNT_LOCKED` audit row pointing at an unlocked account. Measured four
     * runs out of four by the fix round's reviewer.
     *
     * Returns the affected-row count. `0` means the predicate did not hold: the
     * account is locked, and this attempt changes nothing — whichever arm it
     * was.
     */
    updateMany(args: {
      where: IdentityUserFailureWhere;
      data:
        | { failedLoginCount: { increment: 1 } }
        | { failedLoginCount: 0; lockedUntil: null; lastLoginAt: Date }
        | { failedLoginCount: 0; lockedUntil: null };
    }): Promise<{ count: number }>;
  };
  credential: IdentityCredentialDelegate & {
    create(args: { data: { id: string; userId: string; passwordHash: string } }): Promise<unknown>;
  };
  /**
   * "How many sessions is this user holding right now?", asked inside the
   * transaction that replaces their credential.
   *
   * Task 10, and the reason it is a COUNT rather than a list is
   * `security/audit.md` §4: one audit row per revoked session would let an
   * unauthenticated caller — anyone who can trigger a reset — size the session
   * table for an account they do not own.
   *
   * The predicate is "not revoked", which is what `revokeAllForUser` will act
   * on a moment later. It is deliberately NOT the same number as that call's
   * return value, and `password-reset.service.ts` explains at length why the
   * metadata field is named `liveSessionsAtWrite` rather than
   * `sessionsRevoked`: the count is taken at the instant the new hash commits
   * and the revocation happens afterwards, so a session created in between is
   * revoked by the `updateMany` (ruling 51) and was never in this number.
   * Naming it for what it measures is the difference between a fact and a
   * false statement in an append-only table.
   */
  session: {
    count(args: {
      where: { userId: string; revokedAt: null; id?: { not: string } };
    }): Promise<number>;
  };
}

/**
 * The stored password hash, read on its own.
 *
 * `Credential.userId` is `@unique`, so this is one index probe. It is a
 * separate delegate from `user` deliberately: `IdentityUserRow` gets passed
 * around, returned from helpers and reasoned about in audit code, and a
 * password hash riding along inside it would eventually reach one of those
 * places. Here the hash exists in one local variable, is handed straight to
 * `PasswordService.verify`, and goes nowhere else.
 */
export interface IdentityCredentialDelegate {
  findUnique(args: {
    where: { userId: string };
  }): Promise<{ readonly passwordHash: string } | null>;
  /**
   * THE COMPARE-AND-SWAP THAT MAKES A CREDENTIAL WRITE SURVIVE CONCURRENCY. D3.
   *
   * `where` carries the hash the caller **verified against**, so the update
   * applies only if the stored credential is still the one the decision was
   * made from. Every write on this path is decided from a row read BEFORE a
   * ~40 ms Argon2 operation — verify the old password, hash the new one — which
   * is exactly the shape carry-forward ruling 73 records as Task 9's H1: two
   * concurrent change-password requests both verify against the same old hash,
   * and without this predicate both commit, so the second silently overwrites
   * the first and the user's password is whichever request happened to land
   * last.
   *
   * `count: 0` is a REFUSAL, not a no-op. It means another writer moved the
   * credential between the read and this statement, so the decision to write —
   * not the value — is stale, and the safe answer is to refuse and let the
   * caller retry with a fresh read.
   *
   * Prisma compiles `updateMany` to a single `UPDATE ... WHERE`, so Postgres
   * arbitrates row by row: the loser blocks on the row lock, re-evaluates the
   * predicate against the committed version, and reports `count: 0`. A `SELECT`
   * followed by an `update` passes every sequential test and lets both through.
   * Same discipline and the same reason as `login.service.ts`'s not-locked
   * predicate.
   */
  updateMany(args: {
    where: { userId: string; passwordHash: string };
    data: { passwordHash: string };
  }): Promise<{ count: number }>;
}

/**
 * "Does this user have a confirmed second factor?", and nothing more.
 *
 * The projection is the id alone. `MfaFactor.secretEncrypted` is the secret
 * that gates every MFA challenge and login has no business reading it — Task
 * 11's verification endpoint does. `confirmedAt: { not: null }` is the whole
 * predicate, and it is load-bearing: carry-forward ruling 7 records that an
 * *unconfirmed* factor occupies the `(userId, type)` unique slot, so an
 * abandoned enrolment is a row that exists and must not gate a login.
 */
export interface IdentityMfaFactorDelegate {
  findFirst(args: {
    where: { userId: string; confirmedAt: { not: null } };
    select: { id: true };
  }): Promise<{ readonly id: string } | null>;
}

/**
 * "Has this user signed in from this IP and user agent before?"
 *
 * The narrowest question `security/authentication.md` §3's unfamiliar-session
 * notice can be answered with from the `Session` table, and deliberately not a
 * device-fingerprinting scheme. See `LoginService`'s docblock for what it costs
 * and, more importantly, for what it does not prove.
 *
 * `revokedAt` is NOT in the predicate: a user who signed out from this device
 * yesterday holds no live session from it, and a notice on every sign-in after
 * a sign-out is noise that teaches the recipient to ignore the one that
 * matters.
 */
export interface IdentitySessionDelegate {
  findFirst(args: {
    where: { userId: string; ip: string | null; userAgent: string | null };
    select: { id: true };
  }): Promise<{ readonly id: string } | null>;
}

export interface IdentityStore {
  user: IdentityUserDelegate;
  credential: IdentityCredentialDelegate;
  mfaFactor: IdentityMfaFactorDelegate;
  session: IdentitySessionDelegate;
  $transaction<T>(run: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}

/**
 * True for Prisma's unique-constraint violation.
 *
 * Detected structurally rather than with `instanceof PrismaClientKnownRequestError`,
 * because the generated client is fenced off from application code by
 * `no-restricted-imports` (`eslint.config.js`) — importing the error class here
 * would mean widening that fence for a string comparison.
 *
 * The only unique constraint registration can hit is `User.email`, and it can
 * hit it exactly once: two requests registering the same new address at the
 * same instant. See `registration.service.ts`.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
