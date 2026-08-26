import { Inject, Injectable } from '@nestjs/common';
import { PRISMA } from '../../infrastructure/tokens.js';

/**
 * The two values `enum SessionStatus` holds in `schema.prisma`.
 *
 * A restatement, and therefore subject to carry-forward ruling 13: a
 * restatement needs something that reads the schema, not a comment.
 * `session.service.spec.ts` compares this list against `datamodelEnums()` and
 * fails if either side gains a value the other lacks. It is restated rather
 * than imported because the generated Prisma client is fenced off from
 * application code by `no-restricted-imports` (`eslint.config.js`).
 *
 * `PENDING_MFA` and `ACTIVE` are not two flavours of the same thing.
 * `security/authentication.md` §5: the pending session "can do nothing but
 * complete MFA". Task 7 owns enforcing that; this module owns making sure the
 * distinction is always written down, which is carry-forward ruling 6 — the
 * column has no `@default`, so every insert states it and forgetting is a
 * compile error rather than a silently privileged session.
 */
export const SESSION_STATUSES = ['PENDING_MFA', 'ACTIVE'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A `Session` row, as this module reads it. */
export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly activeOrganizationId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly status: SessionStatus;
  readonly lastSeenAt: Date;
  readonly mfaCompletedAt: Date | null;
  readonly rememberMe: boolean;
  readonly rotatedFromId: string | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/** Everything an insert states. Note `status`: ruling 6 makes it required. */
export interface SessionCreateData {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly status: SessionStatus;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly lastSeenAt: Date;
  readonly rememberMe: boolean;
  readonly activeOrganizationId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly mfaCompletedAt: Date | null;
  readonly rotatedFromId: string | null;
}

/**
 * The predicate shapes this module builds, and no others.
 *
 * Narrow on purpose: a `where` typed as Prisma's own would let any later caller
 * express a query with no `revokedAt` clause and no `userId`, which is the
 * shape of an accidental revoke-everybody. Every field here appears in a query
 * below.
 */
interface SessionWhere {
  readonly id?: string | { not: string };
  readonly userId?: string;
  readonly activeOrganizationId?: string;
  readonly revokedAt?: null;
}

/**
 * The slice of Prisma this repository uses — the same narrow-port shape
 * `TokenService`'s `VerificationTokenStore` uses, for the same reason: handing
 * a service the whole `PrismaClient` makes every spec that touches it either a
 * mock of the world or an integration test.
 *
 * `updateMany` and not `update` is load-bearing, not a style choice. See
 * `rotate` and `revoke` below: the affected-row count of one conditional
 * `UPDATE` is what arbitrates between two concurrent callers, and `update`
 * (which addresses a row by unique key and throws when it is missing) cannot
 * express the condition that makes that work.
 */
interface SessionDelegate {
  create(args: { data: SessionCreateData }): Promise<unknown>;
  findUnique(args: { where: { tokenHash: string } | { id: string } }): Promise<SessionRow | null>;
  findMany(args: { where: SessionWhere }): Promise<readonly SessionRow[]>;
  updateMany(args: {
    where: SessionWhere;
    data: { revokedAt?: Date; lastSeenAt?: Date; idleExpiresAt?: Date };
  }): Promise<{ count: number }>;
}

/** The transaction handle. Rotation needs two statements to be one decision. */
export interface SessionTransaction {
  session: SessionDelegate;
}

export interface SessionStore {
  session: SessionDelegate;
  $transaction<T>(run: (tx: SessionTransaction) => Promise<T>): Promise<T>;
}

/**
 * POSTGRES ACCESS FOR `Session`, AND NO POLICY.
 *
 * Nothing here knows what a lifetime is, when a session should be renewed, or
 * that a cache exists. Those are `session.service.ts`'s, and the split is what
 * lets the concurrency properties below be asserted against a real database
 * without dragging the whole policy surface into the harness.
 *
 * **`Session` is user-owned, not tenant-owned**, and `schema.prisma` says so on
 * the model: it is deliberately absent from the tenant resource registry, so
 * `pnpm check:registry` neither knows nor should know about it. `organizationId`
 * on a session is `activeOrganizationId` — which organisation the user is
 * currently acting in — not the tenant that owns the row. A membership removal
 * revoking a user's sessions *for that organisation* reads that column
 * (`permissions.md` invariant 5, Task 14); it is not tenant scoping.
 */
@Injectable()
export class SessionRepository {
  constructor(@Inject(PRISMA) private readonly store: SessionStore) {}

  async create(data: SessionCreateData): Promise<void> {
    await this.store.session.create({ data });
  }

  /** The hot path. `tokenHash` is `@unique`, so this is one index probe. */
  findByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.store.session.findUnique({ where: { tokenHash } });
  }

  findById(id: string): Promise<SessionRow | null> {
    return this.store.session.findUnique({ where: { id } });
  }

  /**
   * Moves the idle clock forward, and reports whether the row was still live.
   *
   * `revokedAt: null` in the predicate is not defensive tidiness: it makes a
   * renewal that races a revocation report `count: 0`, which the service reads
   * as "this session is gone" rather than resurrecting a revoked row's idle
   * window. `absoluteExpiresAt` is deliberately untouched — it never moves, per
   * the comment on the model in `schema.prisma`.
   */
  async touch(input: { id: string; lastSeenAt: Date; idleExpiresAt: Date }): Promise<boolean> {
    const { count } = await this.store.session.updateMany({
      where: { id: input.id, revokedAt: null },
      data: { lastSeenAt: input.lastSeenAt, idleExpiresAt: input.idleExpiresAt },
    });
    return count === 1;
  }

  /**
   * Revokes one session, and reports whether *this* call is the one that did
   * it.
   *
   * The count, not a preceding read, is the decision — the same reasoning
   * `TokenService.consume` records. Two concurrent logouts of one session both
   * pass a read-then-write check; only one of them can be the transaction that
   * turns `revokedAt` from NULL to a value.
   */
  async revokeById(id: string, revokedAt: Date): Promise<boolean> {
    const { count } = await this.store.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
    return count === 1;
  }

  /**
   * Every live session of a user, optionally excluding one, optionally
   * narrowed to the organisation the session is currently acting in.
   *
   * Served by `@@index([userId, lastSeenAt(sort: Desc)])`, which
   * `schema.prisma` records as existing for exactly this and for
   * `/settings/security`'s list.
   *
   * **Deliberately unbounded, against the "every list paginates" rule.** That
   * rule is about endpoints, and this is not one: the caller is bulk revocation,
   * which needs the cache key of *every* affected session. A page limit here
   * would leave the sessions past the limit revoked in Postgres and still warm
   * in Redis, which is the precise failure the cache tombstone exists to
   * prevent. The row count is bounded by how many times one human has signed in
   * without signing out.
   */
  listLiveForUser(input: {
    userId: string;
    organizationId?: string | undefined;
    exceptSessionId?: string | undefined;
  }): Promise<readonly SessionRow[]> {
    return this.store.session.findMany({
      where: {
        userId: input.userId,
        revokedAt: null,
        ...(input.organizationId === undefined
          ? {}
          : { activeOrganizationId: input.organizationId }),
        ...(input.exceptSessionId === undefined ? {} : { id: { not: input.exceptSessionId } }),
      },
    });
  }

  /** The bulk half of the above. Returns how many rows this call revoked. */
  async revokeLiveForUser(input: {
    userId: string;
    organizationId?: string | undefined;
    exceptSessionId?: string | undefined;
    revokedAt: Date;
  }): Promise<number> {
    const { count } = await this.store.session.updateMany({
      where: {
        userId: input.userId,
        revokedAt: null,
        ...(input.organizationId === undefined
          ? {}
          : { activeOrganizationId: input.organizationId }),
        ...(input.exceptSessionId === undefined ? {} : { id: { not: input.exceptSessionId } }),
      },
      data: { revokedAt: input.revokedAt },
    });
    return count;
  }

  /**
   * Revokes one session and inserts its successor, as one decision.
   *
   * **THE AFFECTED-ROW COUNT IS THE GATE, AND IT IS ENOUGH HERE.**
   * Carry-forward ruling 31 requires every supersede-then-insert pair to be
   * examined for the defect `TokenService.issue` shipped: under READ COMMITTED
   * a second transaction cannot see the first's uncommitted `INSERT`, so a
   * supersede predicate matching *rows that do not exist yet* silently
   * supersedes nothing and both rows commit live. `issue` holds
   * `pg_advisory_xact_lock` because its predicate is
   * `(userId, purpose) WHERE consumedAt IS NULL` over a **non-unique** index —
   * there is no row for the second transaction to block on.
   *
   * Rotation is not that shape. It supersedes **one already-committed row by
   * primary key**, so the second transaction's `UPDATE` blocks on that row's
   * lock, and when the first commits it re-evaluates `revokedAt IS NULL`
   * against the committed version and reports `count: 0`. Postgres arbitrates;
   * no application lock is needed. This is `TokenService.consume`'s shape, not
   * `issue`'s.
   *
   * **Measured rather than argued**, as ruling 31 requires: ten rounds of two
   * parallel rotations of one session in `session.service.integration.spec.ts`
   * produced exactly one live successor every time, and the same probe against
   * a deliberately read-then-write rotation produced two. Both outputs are in
   * this task's report.
   *
   * There is **no read inside this transaction**. The successor's inherited
   * columns are read by the caller beforehand, outside it, precisely so that
   * nothing in here can be mistaken for the decision: the `UPDATE`'s count is
   * the only thing that admits a rotation, and a stale read of immutable
   * columns (`userId`, `rememberMe`, `absoluteExpiresAt`) cannot admit a second
   * one.
   *
   * The order is not interchangeable. Inserting before superseding would be
   * harmless here — the predicate names one id — but revoking first keeps this
   * method the same shape as `TokenService.issue`, where the order *is*
   * load-bearing, so a reader comparing them is not led to conclude the two are
   * different in a way they are not.
   */
  rotate(input: {
    currentId: string;
    revokedAt: Date;
    successor: SessionCreateData;
  }): Promise<boolean> {
    return this.store.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: input.currentId, revokedAt: null },
        data: { revokedAt: input.revokedAt },
      });
      if (count !== 1) return false;

      await tx.session.create({ data: input.successor });
      return true;
    });
  }
}
