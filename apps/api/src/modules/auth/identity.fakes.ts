import type { Mailer, OutgoingMail, SentMail } from '../../infrastructure/mail/mailer.port.js';
import type { IdentityStore, IdentityTransaction, IdentityUserRow } from './identity.store.js';

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
  readonly calls: RecordedCall[];
  /** Rows `user.findUnique` answers with, keyed by email and by id. */
  readonly users: Map<string, IdentityUserRow>;
  readonly control: {
    /** Set to make `$transaction` reject at commit, after its body has run. */
    failTransaction: Error | null;
    /** Set to make `tx.user.create` reject, e.g. with a P2002-shaped error. */
    failUserCreate: unknown;
  };
  /** The `tokenHash` of every token issued through the fake transaction. */
  readonly issuedTokenHashes: string[];
}

export function identityStoreFake(): IdentityStoreFake {
  const calls: RecordedCall[] = [];
  const users = new Map<string, IdentityUserRow>();
  const issuedTokenHashes: string[] = [];
  const control = { failTransaction: null as Error | null, failUserCreate: null as unknown };

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
        return Promise.resolve({ count: 0 });
      },
      findUnique: (args) => {
        calls.push({ name: 'tx.verificationToken.findUnique', args: args.where });
        return Promise.resolve(null);
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

  return { store, calls, users, control, issuedTokenHashes };
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
