import { describe, expect, it } from 'vitest';
import { datamodelEnums } from '@sentinel/db';
import { hashSecretToken } from './secret-token.js';
import {
  SECRET_TOKEN_KINDS,
  type SecretTokenTtlSeconds,
  TokenService,
  VERIFICATION_PURPOSES,
  type VerificationTokenStore,
} from './token.service.js';

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

interface Call {
  readonly method: 'create' | 'updateMany' | 'findUnique';
  readonly args: unknown;
  readonly inTransaction: boolean;
}

/**
 * A recording double for the narrow store port.
 *
 * It does NOT simulate row storage, and that is deliberate: the properties this
 * file can honestly assert are which statements are issued, in which order, and
 * with which arguments. Whether the conditional update actually arbitrates two
 * concurrent redemptions is a property of Postgres, and asserting it against a
 * fake would be mocking the thing under test — that lives in
 * `token.service.integration.spec.ts` against a real database instead.
 */
function recordingStore(updateCounts: number[] = [], row: { userId: string } | null = null) {
  const calls: Call[] = [];
  let inTransaction = false;
  const counts = [...updateCounts];

  const delegate = {
    create(args: unknown) {
      calls.push({ method: 'create', args, inTransaction });
      return Promise.resolve({});
    },
    updateMany(args: unknown) {
      calls.push({ method: 'updateMany', args, inTransaction });
      return Promise.resolve({ count: counts.shift() ?? 0 });
    },
    findUnique(args: unknown) {
      calls.push({ method: 'findUnique', args, inTransaction });
      return Promise.resolve(row);
    },
  };

  const store = {
    verificationToken: delegate,
    async $transaction<T>(run: (tx: { verificationToken: typeof delegate }) => Promise<T>) {
      inTransaction = true;
      try {
        return await run({ verificationToken: delegate });
      } finally {
        inTransaction = false;
      }
    },
  } satisfies VerificationTokenStore;

  return { store, calls };
}

describe('TokenService TTLs', () => {
  it('covers all three token kinds authentication.md §6 names', () => {
    // Ruling 8: the invitation TTL is read by Task 15, not by anything here, so
    // it has to be reachable or it is dead weight.
    const service = new TokenService(recordingStore().store, TTL);
    expect(service.ttlSecondsFor('EMAIL_VERIFICATION')).toBe(86_400);
    expect(service.ttlSecondsFor('PASSWORD_RESET')).toBe(3_600);
    expect(service.ttlSecondsFor('INVITATION')).toBe(604_800);
  });

  it('has a TTL for every value of the Prisma VerificationPurpose enum', () => {
    // THE SPEC THAT TURNS RED IF RULING 2 IS EVER VIOLATED. Adding a value to
    // `enum VerificationPurpose` in schema.prisma without giving it a TTL means
    // `issue` would multiply `undefined` and stamp an Invalid Date. Read from
    // the generated DMMF, not from a literal, for the reason ruling 13 records:
    // Task 2's restatement specs compared a constant to a hard-coded copy of
    // itself in the same package and stayed green when the schema changed.
    const declared = datamodelEnums().find((entry) => entry.name === 'VerificationPurpose');
    expect(declared).toBeDefined();
    expect([...(declared?.values ?? [])].sort()).toEqual([...VERIFICATION_PURPOSES].sort());
    expect(declared?.values.length).toBeGreaterThan(0);
    for (const value of declared?.values ?? []) {
      expect(SECRET_TOKEN_KINDS).toContain(value);
      expect(Object.keys(TTL)).toContain(value);
    }
  });

  it('turns a TTL into an expiry by one multiplication, from the given instant', () => {
    const service = new TokenService(recordingStore().store, TTL);
    const from = new Date('2026-08-26T00:00:00.000Z');
    expect(service.expiresAtFor('PASSWORD_RESET', from).toISOString()).toBe(
      '2026-08-26T01:00:00.000Z',
    );
    expect(service.expiresAtFor('INVITATION', from).toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('TokenService.issue', () => {
  it('supersedes the outstanding tokens BEFORE inserting, both inside one transaction', async () => {
    // Ruling 5, and the order is the whole point: an insert-then-supersede
    // would match the row it just wrote — `consumedAt IS NULL` is true of it —
    // and consume the new token at birth.
    const { store, calls } = recordingStore([1]);
    await new TokenService(store, TTL).issue({ userId: 'usr_1', purpose: 'PASSWORD_RESET' });

    expect(calls.map((call) => call.method)).toEqual(['updateMany', 'create']);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
  });

  it('supersedes only that user and only that purpose', async () => {
    // A reset request must not invalidate the same user's outstanding email
    // verification link, and must never touch another user's rows.
    const { store, calls } = recordingStore([0]);
    await new TokenService(store, TTL).issue({ userId: 'usr_1', purpose: 'EMAIL_VERIFICATION' });

    const { where } = calls[0]?.args as { where: Record<string, unknown> };
    expect(where).toEqual({ userId: 'usr_1', purpose: 'EMAIL_VERIFICATION', consumedAt: null });
  });

  it('persists the hash and never the raw token', async () => {
    // Critical security rule 5, and §6's "hashed at rest". Asserted over every
    // argument of every call rather than over the create args alone, so a later
    // edit cannot smuggle the raw value in through a different statement.
    const { store, calls } = recordingStore([0]);
    const issued = await new TokenService(store, TTL).issue({
      userId: 'usr_1',
      purpose: 'EMAIL_VERIFICATION',
    });

    expect(JSON.stringify(calls)).not.toContain(issued.token);
    expect(calls[1]?.args).toMatchObject({
      data: {
        userId: 'usr_1',
        purpose: 'EMAIL_VERIFICATION',
        tokenHash: hashSecretToken(issued.token),
      },
    });
  });

  it('returns a vtk-prefixed id and an expiry taken from the purpose TTL', async () => {
    const { store, calls } = recordingStore([0]);
    const before = Date.now();
    const issued = await new TokenService(store, TTL).issue({
      userId: 'usr_1',
      purpose: 'PASSWORD_RESET',
    });
    const after = Date.now();

    expect(issued.id).toMatch(/^vtk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.purpose).toBe('PASSWORD_RESET');
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(after + 3_600_000);
    // The row carries the same instant that was returned to the caller.
    expect((calls[1]?.args as { data: { expiresAt: Date } }).data.expiresAt).toEqual(
      issued.expiresAt,
    );
  });

  it('mints a different token every time, so a reissue cannot collide', async () => {
    const service = new TokenService(recordingStore([0, 0]).store, TTL);
    const first = await service.issue({ userId: 'usr_1', purpose: 'PASSWORD_RESET' });
    const second = await service.issue({ userId: 'usr_1', purpose: 'PASSWORD_RESET' });
    expect(first.token).not.toBe(second.token);
    expect(first.id).not.toBe(second.id);
  });
});

describe('TokenService.consume', () => {
  it('gates on the affected-row count of a single conditional update', async () => {
    // Ruling 3. The first statement this service issues on the consume path is
    // the UPDATE — not a SELECT. A read before it, used as the gate, is the
    // account-takeover race the integration spec exists to catch.
    const { store, calls } = recordingStore([1], { userId: 'usr_1' });
    const result = await new TokenService(store, TTL).consume({
      token: 'a-raw-token',
      purpose: 'PASSWORD_RESET',
    });

    expect(calls[0]?.method).toBe('updateMany');
    expect(result?.userId).toBe('usr_1');
  });

  it('sends the full predicate: hash, purpose, unconsumed, unexpired', async () => {
    const { store, calls } = recordingStore([1], { userId: 'usr_1' });
    await new TokenService(store, TTL).consume({
      token: 'a-raw-token',
      purpose: 'EMAIL_VERIFICATION',
    });

    const args = calls[0]?.args as {
      where: { tokenHash: string; purpose: string; consumedAt: null; expiresAt: { gt: Date } };
      data: { consumedAt: Date };
    };
    expect(args.where.tokenHash).toBe(hashSecretToken('a-raw-token'));
    expect(args.where.purpose).toBe('EMAIL_VERIFICATION');
    expect(args.where.consumedAt).toBeNull();
    expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
    // One clock writes and reads (ruling 4): the instant compared against
    // expiresAt is the instant stamped into consumedAt.
    expect(args.data.consumedAt).toEqual(args.where.expiresAt.gt);
  });

  it('looks the token up by hash and never sends the raw value', async () => {
    const { store, calls } = recordingStore([1], { userId: 'usr_1' });
    await new TokenService(store, TTL).consume({ token: 'a-raw-token', purpose: 'PASSWORD_RESET' });
    expect(JSON.stringify(calls)).not.toContain('a-raw-token');
  });

  it('refuses when the update affected no rows, and asks the database nothing further', async () => {
    const { store, calls } = recordingStore([0], { userId: 'usr_1' });
    const result = await new TokenService(store, TTL).consume({
      token: 'a-raw-token',
      purpose: 'PASSWORD_RESET',
    });

    expect(result).toBeNull();
    // A row exists behind `findUnique` here. If the service consulted it as the
    // gate, this refusal would become an acceptance — which is exactly the
    // read-then-write defect. One call, and it is the UPDATE.
    expect(calls).toHaveLength(1);
  });

  it('refuses rather than guessing when the row vanishes after a winning update', async () => {
    // Fail closed. Not reachable in normal operation (tokenHash is unique and
    // the row was just consumed by us), but a null here must never become a
    // successful redemption with an invented userId.
    const { store } = recordingStore([1], null);
    const result = await new TokenService(store, TTL).consume({
      token: 'a-raw-token',
      purpose: 'PASSWORD_RESET',
    });
    expect(result).toBeNull();
  });

  it('refuses a count above one rather than accepting it', async () => {
    // `count === 1`, not `count > 0`. tokenHash is UNIQUE so this cannot happen
    // against the real schema; if that index were ever dropped, accepting would
    // consume several users' tokens on one click.
    const { store } = recordingStore([2], { userId: 'usr_1' });
    const result = await new TokenService(store, TTL).consume({
      token: 'a-raw-token',
      purpose: 'PASSWORD_RESET',
    });
    expect(result).toBeNull();
  });
});
