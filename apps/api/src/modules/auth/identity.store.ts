import type { PlatformAuditTransaction } from '../audit/platform-audit.service.js';
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
   * An absolute value is correct **here and nowhere else on the login path**: a
   * successful login sets the counter to a constant rather than deriving it
   * from a value it read earlier, so there is nothing for a concurrent request
   * to make stale.
   */
  | { readonly failedLoginCount: 0; readonly lockedUntil: null; readonly lastLoginAt: Date }
  /**
   * The MFA arm of a successful login: the counter and the lock clear, and
   * `lastLoginAt` is deliberately not stamped for a session that can do
   * nothing but complete MFA.
   */
  | { readonly failedLoginCount: 0; readonly lockedUntil: null };

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
  user: IdentityUserDelegate & {
    create(args: { data: { id: string; email: string; name: string | null } }): Promise<unknown>;
    update(args: { where: { id: string }; data: IdentityUserUpdateData }): Promise<unknown>;
    /**
     * The atomic failure increment. **Only ever `{ increment: 1 }`** — the type
     * admits no absolute value, because an absolute value derived from an
     * earlier read is the H1 defect, and this is the one column on `User` that
     * two requests routinely write at the same instant.
     *
     * Returns the affected-row count. `0` means the predicate did not hold: the
     * account is locked, and this attempt changes nothing.
     */
    updateMany(args: {
      where: IdentityUserFailureWhere;
      data: { failedLoginCount: { increment: 1 } };
    }): Promise<{ count: number }>;
  };
  credential: {
    create(args: { data: { id: string; userId: string; passwordHash: string } }): Promise<unknown>;
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
