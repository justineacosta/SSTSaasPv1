import type { Mailer, OutgoingMail, SentMail } from '../infrastructure/mail/mailer.port.js';
import type {
  IdentityStore,
  IdentityTransaction,
  IdentityUserRow,
} from '../modules/auth/identity.store.js';
import type { VerificationTokenStore } from '../modules/auth/token.service.js';

/**
 * The recording doubles the registration and verification unit specs share.
 *
 * A file rather than a copy in each spec, and `.ts` rather than `.spec.ts` so
 * `pnpm check:specs` does not have to claim it for a Vitest project: it
 * contains no tests. It is imported only by specs.
 *
 * **These fakes make nothing true by construction that a spec is asserting.**
 * They record calls and hand back rows a test set up; the properties that need
 * a real database — single use, supersession, the partial unique index, the
 * append-only trigger, tenant isolation — are asserted in the integration lane
 * instead. What these are for is the ordering and branching a database cannot
 * show: that the mail is sent after the transaction and never inside it, that a
 * transaction which fails at commit sends nothing at all, and that the Argon2id
 * hash is paid on both registration paths.
 *
 * The mutable switches live on a nested `control` object rather than on the
 * returned fake itself. A spread of a flat object would copy the flag and the
 * closure would go on reading the original — a fake that silently ignores the
 * setting a test just made is worse than no fake.
 */

export interface RecordedCall {
  readonly name: string;
  readonly args?: unknown;
}

export interface IdentityStoreFake {
  readonly store: IdentityStore;
  /** The same fake, typed as `TokenService` needs it. See `tokenStore` below. */
  readonly tokenStore: VerificationTokenStore;
  readonly calls: RecordedCall[];
  /** Rows `user.findUnique` answers with, keyed by email and by id. */
  readonly users: Map<string, IdentityUserRow>;
  readonly control: {
    /** Set to make `$transaction` reject at commit, after its body has run. */
    failTransaction: Error | null;
    /**
     * Set to make `tx.user.create` reject.
     *
     * An `Error`, not `unknown`, because Prisma's own
     * `PrismaClientKnownRequestError` is one — it carries `code: 'P2002'` as a
     * property. A plain object would have been a fake that rejects with
     * something the real client never produces.
     */
    failUserCreate: Error | null;
    /**
     * Set to make one token redemption SUCCEED, returning this `userId`.
     *
     * Off by default, and the default is the honest one: `updateMany` reporting
     * `count: 0` is why this file's consumers can only exercise the refusing
     * half of `consume`, because the accepting half depends on an `UPDATE`'s
     * affected-row count against a real row — a fake makes that true by
     * construction, which is carry-forward ruling 58's family of defect.
     *
     * It exists for one case a real database cannot produce: a live token whose
     * user row is gone. `VerificationToken.userId` is `onDelete: Cascade`, so
     * deleting the user deletes the token, and the `user === null` arm in
     * `EmailVerificationService.verify` is therefore unreachable in an
     * integration test (L4, Task 8 review — the branch's mutant survived both
     * lanes). It is defence against a future schema change rather than dead
     * code, and this flag is the only way to hold it to that.
     *
     * It fakes the OUTCOME of a redemption, never its concurrency property.
     * Nothing here may be read as evidence that the conditional update
     * arbitrates two racing redeemers; `token.service.integration.spec.ts` owns
     * that against real Postgres.
     */
    redeemableUserId: string | null;
  };
  /** The `tokenHash` of every token issued through the fake transaction. */
  readonly issuedTokenHashes: string[];
}

export function identityStoreFake(): IdentityStoreFake {
  const calls: RecordedCall[] = [];
  const users = new Map<string, IdentityUserRow>();
  const issuedTokenHashes: string[] = [];
  const control = {
    failTransaction: null as Error | null,
    failUserCreate: null as Error | null,
    redeemableUserId: null as string | null,
  };

  const find = (where: { email: string } | { id: string }): IdentityUserRow | null =>
    users.get('email' in where ? where.email : where.id) ?? null;

  const tx: IdentityTransaction = {
    user: {
      findUnique: (args) => {
        calls.push({ name: 'tx.user.findUnique', args: args.where });
        return Promise.resolve(find(args.where));
      },
      create: (args) => {
        calls.push({ name: 'tx.user.create', args: args.data });
        if (control.failUserCreate !== null) return Promise.reject(control.failUserCreate);
        return Promise.resolve(undefined);
      },
      update: (args) => {
        calls.push({ name: 'tx.user.update', args: { where: args.where, data: args.data } });
        return Promise.resolve(undefined);
      },
    },
    credential: {
      create: (args) => {
        // The user id is recorded and the hash is not. A recorded hash is a
        // recorded credential, even a fake one, and `pnpm check:secrets` reads
        // committed files rather than test output.
        calls.push({ name: 'tx.credential.create', args: { userId: args.data.userId } });
        return Promise.resolve(undefined);
      },
    },
    verificationToken: {
      create: (args) => {
        calls.push({ name: 'tx.verificationToken.create', args: { userId: args.data.userId } });
        issuedTokenHashes.push(args.data.tokenHash);
        return Promise.resolve(undefined);
      },
      updateMany: (args) => {
        calls.push({ name: 'tx.verificationToken.updateMany', args: args.where });
        // `tokenHash` in the predicate marks the REDEMPTION update; `issue`'s
        // supersede pass keys on `userId` + `purpose` and carries no hash. Only
        // the former may report a hit, so setting the flag cannot accidentally
        // make a supersede look like it consumed a row. (An earlier comment here
        // named `consumedAt: null` as the discriminator — F4. Both predicates
        // carry that, so it discriminates nothing; the code was always right and
        // only the sentence was wrong.)
        const isRedemption = 'tokenHash' in args.where;
        return Promise.resolve({
          count: isRedemption && control.redeemableUserId !== null ? 1 : 0,
        });
      },
      findUnique: (args) => {
        calls.push({ name: 'tx.verificationToken.findUnique', args: args.where });
        return Promise.resolve(
          control.redeemableUserId === null ? null : { userId: control.redeemableUserId },
        );
      },
    },
    platformAuditEvent: {
      create: (args) => {
        calls.push({ name: 'tx.platformAuditEvent.create', args: { ...args.data } });
        return Promise.resolve(undefined);
      },
    },
    $queryRaw: () => {
      calls.push({ name: 'tx.$queryRaw' });
      return Promise.resolve(undefined);
    },
  };

  const store: IdentityStore = {
    user: {
      findUnique: (args) => {
        calls.push({ name: 'user.findUnique', args: args.where });
        return Promise.resolve(find(args.where));
      },
    },
    $transaction: async (run) => {
      calls.push({ name: '$transaction:begin' });
      const result = await run(tx);
      if (control.failTransaction !== null) {
        // A COMMIT that fails, which is the case carry-forward ruling 44 is
        // about: every statement inside succeeded, so a send placed at the end
        // of the callback would already have happened. Prisma surfaces this as
        // a rejection from `$transaction`, exactly as here.
        calls.push({ name: '$transaction:rollback' });
        throw control.failTransaction;
      }
      calls.push({ name: '$transaction:commit' });
      return result;
    },
  };

  /**
   * The same fake, narrowed to what `TokenService` takes.
   *
   * `IdentityStore.$transaction` hands its callback an `IdentityTransaction`,
   * which is a SUBTYPE of `VerificationTokenTransaction` — so the store is not
   * assignable to `VerificationTokenStore` and `pnpm typecheck` says so (it
   * was red while `pnpm test` was green: carry-forward ruling 40, again). In
   * production both services are handed the same real `PrismaClient` through
   * one DI token; this is the spec-side equivalent of that, and it delegates
   * to the same transaction so the recorded call list stays one list.
   */
  const tokenStore: VerificationTokenStore = {
    verificationToken: tx.verificationToken,
    $transaction: (run) => store.$transaction(run),
  };

  return { store, tokenStore, calls, users, control, issuedTokenHashes };
}

export interface MailerFake {
  readonly mailer: Mailer;
  readonly sent: OutgoingMail[];
  readonly control: {
    /** Set to make every send throw, the way a refused relay does. */
    failWith: Error | null;
  };
}

export function mailerFake(): MailerFake {
  const sent: OutgoingMail[] = [];
  const control = { failWith: null as Error | null };
  const mailer: Mailer = {
    send: (mail): Promise<SentMail> => {
      if (control.failWith !== null) return Promise.reject(control.failWith);
      sent.push(mail);
      return Promise.resolve({ messageId: `fake-${String(sent.length)}` });
    },
  };
  return { mailer, sent, control };
}
