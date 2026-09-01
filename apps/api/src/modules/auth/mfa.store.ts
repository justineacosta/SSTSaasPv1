import type { PlatformAuditTransaction } from '../audit/platform-audit.service.js';

/**
 * THE NARROW PRISMA PORT THE MFA SERVICES SEE.
 *
 * The same shape and the same reason as `identity.store.ts` next door: a
 * service typed against the whole `PrismaClient` makes every spec that touches
 * it either a mock of the world or an integration test, and what is written out
 * here is a readable inventory of exactly which tables and operations the MFA
 * surface touches.
 *
 * A separate port from `IdentityStore` rather than an extension of it.
 * `LoginService` reads one thing about MFA — "is there a confirmed factor" —
 * and must not be able to reach a secret; widening its port to carry
 * `secretEncrypted` would put the value that gates every MFA challenge inside
 * the type the login path already handles.
 *
 * **CARRY-FORWARD RULING 9 IS THE RULE OVER THIS WHOLE FILE.** `MfaFactor` and
 * `RecoveryCode` are user-owned and carry **no row-level security**, so there
 * is no database layer behind any query here. Every `userId` in every predicate
 * below comes from `request.principal` — set by `AuthenticationGuard` from a
 * session cookie — or from a resolved `PENDING_MFA` session, and never from a
 * path parameter or a request body. There is no handler in this module that
 * takes a user id from a caller.
 */

/**
 * The factor row, as the MFA services read it.
 *
 * `secretEncrypted` is in this shape and in no other. It is handed straight to
 * `decryptMfaSecret`, the plaintext lives in one local variable, and neither
 * ever reaches a log line, an error, or a response body (critical security rule
 * 6).
 */
export interface MfaFactorRow {
  readonly id: string;
  readonly userId: string;
  readonly secretEncrypted: string;
  readonly secretKeyVersion: number | null;
  readonly confirmedAt: Date | null;
  readonly lastAcceptedStep: number | null;
}

export interface MfaFactorDelegate {
  findFirst(args: {
    where: { userId: string; type: 'TOTP' };
    select: {
      id: true;
      userId: true;
      secretEncrypted: true;
      secretKeyVersion: true;
      confirmedAt: true;
      lastAcceptedStep: true;
    };
  }): Promise<MfaFactorRow | null>;
}

/**
 * The two conditional writes that make MFA survive concurrency, and one delete.
 *
 * Both `updateMany` shapes are compare-and-swaps, and `count: 0` is a REFUSAL
 * rather than a no-op in each — the same discipline `identity.store.ts`'s
 * credential `updateMany` records, for the same reason: the decision to write
 * was made from a row read earlier, and a sibling request may have moved it.
 */
export interface MfaFactorTransactionDelegate extends MfaFactorDelegate {
  /**
   * Replaces an ABANDONED ENROLMENT. Carry-forward ruling 7.
   *
   * `MfaFactor` has `@@unique([userId, type])`, so an unconfirmed row left by a
   * user who closed the tab occupies the slot and the next enrolment dies on
   * P2002 — a user who abandons enrolment once has locked themselves out of
   * ever enabling MFA. The predicate is `confirmedAt: null` and it is the
   * security half: re-enrolling over a CONFIRMED factor without proving a code
   * is an account-takeover step, so this statement must be unable to express
   * it.
   */
  deleteMany(args: {
    where: { userId: string; confirmedAt: null } | { userId: string };
  }): Promise<{ count: number }>;
  create(args: {
    data: {
      id: string;
      userId: string;
      type: 'TOTP';
      secretEncrypted: string;
      secretKeyVersion: number;
      confirmedAt: null;
      lastAcceptedStep: number;
    };
  }): Promise<unknown>;
  /**
   * Confirmation, and the replay floor's first write, as one statement.
   *
   * `confirmedAt: null` in the predicate makes confirming idempotent in the
   * safe direction: a second confirmation of an already-confirmed factor
   * reports `count: 0` and is refused, rather than reissuing recovery codes for
   * an account whose factor somebody else already proved.
   */
  updateMany(args: {
    where:
      | { id: string; confirmedAt: null }
      | {
          id: string;
          confirmedAt: { not: null };
          OR: readonly [
            { readonly lastAcceptedStep: null },
            { readonly lastAcceptedStep: { lt: number } },
          ];
        };
    data: { confirmedAt?: Date; lastAcceptedStep: number; lastUsedAt: Date };
  }): Promise<{ count: number }>;
}

export interface RecoveryCodeDelegate {
  findMany(args: {
    where: { userId: string; usedAt: null };
    select: { id: true; codeHash: true };
    take: number;
  }): Promise<readonly { readonly id: string; readonly codeHash: string }[]>;
}

export interface RecoveryCodeTransactionDelegate extends RecoveryCodeDelegate {
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  createMany(args: {
    data: readonly { id: string; userId: string; codeHash: string }[];
  }): Promise<unknown>;
  /**
   * SPENDING A CODE, AS A COMPARE-AND-SWAP. D7.
   *
   * `usedAt: null` in the predicate is what makes "the same code must fail the
   * second time" true under concurrency as well as sequentially. A `SELECT`
   * that finds an unused code followed by an `update` lets two simultaneous
   * requests both find it and both spend it; here Postgres arbitrates on the
   * row lock and the loser reports `count: 0`.
   */
  updateMany(args: {
    where: { id: string; usedAt: null };
    data: { usedAt: Date };
  }): Promise<{ count: number }>;
  count(args: { where: { userId: string; usedAt: null } }): Promise<number>;
}

/** Just enough of `User` for the notice recipients and the `otpauth://` label. */
export interface MfaUserRow {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
}

export interface MfaUserDelegate {
  findUnique(args: {
    where: { id: string };
    select: { id: true; email: true; emailVerifiedAt: true };
  }): Promise<MfaUserRow | null>;
}

/**
 * The credential, read for its hash on the management routes and for its
 * **timestamp** on the promotion path.
 *
 * `updatedAt` is a `@updatedAt` column that has existed since Task 1, which is
 * why D4's check needs no schema change. See
 * `mfa-verification.service.ts` for what it is compared against and why the
 * comparison is not the whole predicate.
 */
export interface MfaCredentialDelegate {
  findUnique(args: {
    where: { userId: string };
    select: { passwordHash: true; updatedAt: true };
  }): Promise<{ readonly passwordHash: string; readonly updatedAt: Date } | null>;
}

/**
 * The pending session's own row, for its `createdAt`.
 *
 * `SessionService.resolve` returns a `ResolvedSession`, which deliberately
 * carries no `createdAt` — nothing else needed it. The promotion does: "was the
 * credential written after this pending session was created" is the whole of
 * D4's question, and the left-hand side of it lives here.
 */
export interface MfaSessionDelegate {
  findUnique(args: {
    where: { id: string };
    select: { id: true; userId: true; createdAt: true };
  }): Promise<{ readonly id: string; readonly userId: string; readonly createdAt: Date } | null>;
  /**
   * "Has this user signed in from this IP and user agent before?" — the same
   * question `identity.store.ts`'s session delegate asks, and deliberately the
   * same one rather than a second definition.
   *
   * D9: the unfamiliar-sign-in notice is sent on MFA completion, because that is
   * where the sign-in actually completes. `login.service.ts` owns the definition
   * of "familiar" and this is a call to the same predicate, not a variation of
   * it.
   */
  findFirst(args: {
    where: {
      userId: string;
      ip: string | null;
      userAgent: string | null;
      /**
       * THE PENDING SESSION EXCLUDES ITSELF, AND WITHOUT THIS THE NOTICE NEVER
       * FIRES.
       *
       * `login.service.ts` asks the familiarity question *before* it issues,
       * precisely because the row it is about to create carries this exact
       * triple. On the MFA arm that row already exists by the time this service
       * runs — login created it — so an unexcluded lookup matches the pending
       * session itself, every completion is "familiar", and the notice is dead
       * code. Same trap, one step later in the flow, and the fix has to be here
       * because the ordering answer is not available.
       */
      id: { not: string };
    };
    select: { id: true };
  }): Promise<{ readonly id: string } | null>;
}

export interface MfaAuditCountDelegate {
  count(args: {
    where: {
      action: string | { in: readonly string[] };
      resourceId: string;
      createdAt?: { gt: Date };
    };
  }): Promise<number>;
}

export interface MfaTransaction extends PlatformAuditTransaction {
  mfaFactor: MfaFactorTransactionDelegate;
  recoveryCode: RecoveryCodeTransactionDelegate;
  user: MfaUserDelegate;
  platformAuditEvent: PlatformAuditTransaction['platformAuditEvent'] & MfaAuditCountDelegate;
  /**
   * The per-session advisory lock. NEW-3 and carry-forward ruling 84.
   *
   * The failed-attempt counter is READ inside the transaction that WRITES a
   * failure row, and Prisma runs interactive transactions at Postgres READ
   * COMMITTED — so without this, concurrent failures cannot see one another's
   * uncommitted rows, several can each count exactly the threshold, and the
   * lock fires more than once or not at all. This is the identical mechanism
   * `password-change.service.ts` takes for the identical reason, and
   * `TokenService.issue` before it.
   *
   * The subquery wrapper is theirs too: `pg_advisory_xact_lock` returns `void`
   * and `$queryRaw` cannot deserialise that.
   */
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export interface MfaStore {
  mfaFactor: MfaFactorDelegate;
  recoveryCode: RecoveryCodeDelegate;
  user: MfaUserDelegate;
  credential: MfaCredentialDelegate;
  session: MfaSessionDelegate;
  /**
   * READ-ONLY, and outside a transaction deliberately.
   *
   * D4's second stage asks "was this account's password REPLACED after the
   * pending session was created" — a question about rows another service
   * committed, so there is nothing here for it to be atomic with. Every WRITE
   * to this table still goes through `PlatformAuditService.record` inside a
   * caller-supplied transaction, which is `security/audit.md` §2's rule
   * expressed as a signature; this is the one read.
   */
  platformAuditEvent: MfaAuditCountDelegate;
  $transaction<T>(run: (tx: MfaTransaction) => Promise<T>): Promise<T>;
}
