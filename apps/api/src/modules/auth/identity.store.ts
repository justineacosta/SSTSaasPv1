import type { PlatformAuditTransaction } from '../audit/platform-audit.service.js';
import type { VerificationTokenTransaction } from './token.service.js';

/**
 * THE NARROW PRISMA PORT THE REGISTRATION AND VERIFICATION SERVICES SEE.
 *
 * The same shape `TokenService`'s `VerificationTokenStore` and
 * `HealthService`'s `DatabaseProbe` use, and for the same reason: a service
 * typed against the whole `PrismaClient` makes every spec that touches it
 * either a mock of the world or an integration test. What is written out here
 * is exactly the four tables and six operations these two services perform,
 * which is also a readable inventory of everything registration touches.
 *
 * The transaction type extends `VerificationTokenTransaction` and
 * `PlatformAuditTransaction`, which is what lets one `$transaction` carry the
 * user, the credential, the verification token and the audit event —
 * `security/audit.md` §2's "in the same transaction as the change".
 */

/** The `User` columns these services read. Nothing selects a password hash. */
export interface IdentityUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly emailVerifiedAt: Date | null;
  /** `UserStatus` — `ACTIVE`, `LOCKED` or `DISABLED`. */
  readonly status: string;
}

export interface IdentityUserDelegate {
  findUnique(args: { where: { email: string } | { id: string } }): Promise<IdentityUserRow | null>;
}

export interface IdentityTransaction
  extends VerificationTokenTransaction, PlatformAuditTransaction {
  user: IdentityUserDelegate & {
    create(args: { data: { id: string; email: string; name: string | null } }): Promise<unknown>;
    update(args: { where: { id: string }; data: { emailVerifiedAt: Date } }): Promise<unknown>;
  };
  credential: {
    create(args: { data: { id: string; userId: string; passwordHash: string } }): Promise<unknown>;
  };
}

export interface IdentityStore {
  user: IdentityUserDelegate;
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
