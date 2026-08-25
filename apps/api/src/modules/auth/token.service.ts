import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@sentinel/db';
import { PRISMA } from '../../infrastructure/tokens.js';
import { SECRET_TOKEN_TTL_SECONDS } from './auth.tokens.js';
import { hashSecretToken, mintSecretToken } from './secret-token.js';

/**
 * The two purposes `VerificationToken` can actually hold.
 *
 * A restatement of `enum VerificationPurpose` in `schema.prisma`, and therefore
 * subject to carry-forward ruling 13: the restatement needs something that
 * reads the schema, not a comment. `token.service.spec.ts` compares this list
 * against `datamodelEnums()` and fails if either side gains a value the other
 * lacks. It is restated rather than imported because the generated Prisma
 * client is fenced off from application code by `no-restricted-imports`.
 */
export const VERIFICATION_PURPOSES = ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/**
 * All three kinds `security/authentication.md` §6 gives one discipline.
 *
 * `INVITATION` is deliberately here and deliberately NOT a `VerificationPurpose`:
 * `Invitation` is tenant-owned, carries its own `tokenHash`, and its invitee may
 * have no `User` row at all, so it can never be a `VerificationToken`. What it
 * shares is the primitive in `secret-token.ts` and the TTL below, which Task 15
 * reads through `ttlSecondsFor('INVITATION')`.
 */
export const SECRET_TOKEN_KINDS = [...VERIFICATION_PURPOSES, 'INVITATION'] as const;
export type SecretTokenKind = (typeof SECRET_TOKEN_KINDS)[number];

/** Seconds, for all three, deliberately. See the block in `packages/config`. */
export type SecretTokenTtlSeconds = Readonly<Record<SecretTokenKind, number>>;

/**
 * The slice of Prisma this service uses. A test supplies a recording double
 * instead — the same narrow-port shape `HealthService`'s `DatabaseProbe` uses,
 * and for the same reason: handing a service the whole `PrismaClient` makes
 * every spec that touches it either a mock of the world or an integration test.
 *
 * `updateMany` rather than `update` is load-bearing, not a style choice — see
 * `consume` below.
 */
interface VerificationTokenWhere {
  readonly id?: string;
  readonly userId?: string;
  readonly purpose?: VerificationPurpose;
  readonly tokenHash?: string;
  readonly consumedAt?: null;
  readonly expiresAt?: { gt: Date };
}

interface VerificationTokenDelegate {
  create(args: {
    data: {
      id: string;
      userId: string;
      purpose: VerificationPurpose;
      tokenHash: string;
      expiresAt: Date;
    };
  }): Promise<unknown>;
  updateMany(args: {
    where: VerificationTokenWhere;
    data: { consumedAt: Date };
  }): Promise<{ count: number }>;
  findUnique(args: { where: { tokenHash: string } }): Promise<{ userId: string } | null>;
}

export interface VerificationTokenStore {
  verificationToken: VerificationTokenDelegate;
  $transaction<T>(
    run: (tx: { verificationToken: VerificationTokenDelegate }) => Promise<T>,
  ): Promise<T>;
}

export interface IssueTokenInput {
  readonly userId: string;
  readonly purpose: VerificationPurpose;
}

/**
 * What the caller gets back from `issue`, containing the raw token **once**.
 *
 * The raw value exists nowhere else: not in the row, not in a log, not in an
 * `AuditEvent`'s metadata, and not in a second call. The only legitimate
 * consumer is the mailer (Task 5), which puts it in a link and drops it.
 */
export interface IssuedToken {
  readonly id: string;
  readonly purpose: VerificationPurpose;
  readonly expiresAt: Date;
  /** Raw secret, returned exactly once. Never persist, never log. */
  readonly token: string;
}

export interface ConsumeTokenInput {
  /** The raw token from the link. Hashed here; never stored, never logged. */
  readonly token: string;
  readonly purpose: VerificationPurpose;
}

export interface ConsumedToken {
  readonly userId: string;
  readonly purpose: VerificationPurpose;
  readonly consumedAt: Date;
}

const MILLISECONDS = 1_000;

/**
 * LAYER 2: `VerificationToken` PERSISTENCE FOR THE TWO PURPOSES THAT HAVE A ROW.
 *
 * `security/authentication.md` §6 gives email verification, password reset and
 * invitation one discipline. One *discipline* is not one table — see
 * `secret-token.ts` for why — so this class owns the half of it that is stateful
 * for the two purposes `VerificationToken` models, and `secret-token.ts` owns
 * the half all three share.
 *
 * **This service never writes an `AuditEvent`.** `AuditEvent.organizationId` is
 * NOT NULL with a `Restrict` FK to `Organization` (`schema.prisma`), and a
 * verification or reset token is issued to a user who may belong to no
 * organisation — which is every user during registration. Inventing an id here
 * would either fabricate a foreign key or make issuance fail for exactly the
 * people it exists for. The audit event belongs to the endpoint, which has the
 * organisation context: Tasks 8, 10 and 15. **The raw token never enters that
 * event's metadata.**
 *
 * **It also raises nothing.** `consume` returns `null` for every refusal and the
 * caller turns that into `TokenInvalidError` — one code, one message, for
 * unknown, expired, consumed and superseded alike, so the endpoint cannot become
 * an account oracle.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(PRISMA) private readonly store: VerificationTokenStore,
    @Inject(SECRET_TOKEN_TTL_SECONDS) private readonly ttlSeconds: SecretTokenTtlSeconds,
  ) {}

  /** The configured TTL for any of §6's three kinds, invitations included. */
  ttlSecondsFor(kind: SecretTokenKind): number {
    return this.ttlSeconds[kind];
  }

  /**
   * The one place seconds become an instant, so no caller repeats the
   * multiplication — the reason all three variables carry the same unit.
   */
  expiresAtFor(kind: SecretTokenKind, from: Date = new Date()): Date {
    return new Date(from.getTime() + this.ttlSecondsFor(kind) * MILLISECONDS);
  }

  /**
   * Mints a token for `userId` and `purpose`, invalidating that user's
   * outstanding tokens of the same purpose in the same transaction.
   *
   * **Supersession sets `consumedAt`, and there is no second column.** §6 treats
   * "used" and "replaced by a newer token" as one outcome — both mean the link
   * in that email no longer works — and the schema has exactly one column for
   * it. It also keeps the consume predicate a single `consumedAt IS NULL`
   * instead of two conditions that can disagree. The cost is that a row can no
   * longer distinguish "the user clicked" from "a newer request replaced it";
   * the forensic record for that is the endpoint's `AuditEvent`, not this row.
   *
   * **The order inside the transaction is not interchangeable.** Superseding
   * after the insert would match the row just written — `consumedAt IS NULL` is
   * true of it — and consume the new token at birth.
   */
  async issue(input: IssueTokenInput): Promise<IssuedToken> {
    const { userId, purpose } = input;
    const minted = mintSecretToken();
    const issuedAt = new Date();
    const expiresAt = this.expiresAtFor(purpose, issuedAt);
    const id = newId('vtk');

    await this.store.$transaction(async (tx) => {
      await tx.verificationToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: issuedAt },
      });
      await tx.verificationToken.create({
        data: { id, userId, purpose, tokenHash: minted.tokenHash, expiresAt },
      });
    });

    return { id, purpose, expiresAt, token: minted.token };
  }

  /**
   * Redeems a token, or refuses. `null` is every refusal: unknown, expired,
   * already consumed, superseded.
   *
   * **The affected-row count of one conditional UPDATE is the decision.** Prisma
   * compiles `updateMany` to a single `UPDATE ... WHERE`, so the database
   * arbitrates: of two requests redeeming the same link at the same instant,
   * the first to acquire the row's lock writes `consumedAt` and reports
   * `count: 1`; the second re-evaluates `consumedAt IS NULL` against the
   * committed row and reports `count: 0`. A `SELECT` followed by an `UPDATE`
   * passes every sequential test and lets both succeed, which for a password
   * reset link is an account takeover, not an untidiness. That is what
   * `token.service.integration.spec.ts` fires two parallel redemptions at.
   *
   * `count === 1`, not `count > 0`: `tokenHash` is `@unique`, so anything else
   * means the schema is not what this code believes and the safe answer is to
   * refuse.
   *
   * **The read happens after the gate, never before it.** `updateMany` returns
   * only a count, and the caller needs the `userId`, so one lookup is
   * unavoidable — but placing it *after* a winning update makes it structurally
   * impossible for a stale read to become the accept/refuse decision. It needs
   * no transaction: `tokenHash` is unique and the row was just consumed by this
   * request, so nothing can move it back. A `null` here is a database anomaly
   * and fails closed rather than inventing a `userId`.
   *
   * **The clock is this process's** (`new Date()` both stamps `expiresAt` at
   * issue and compares it here). Skew between API instances shifts a token's
   * effective lifetime by that skew — bounded by NTP, and irrelevant against
   * TTLs of 1h to 7d. It cannot affect the concurrency property above, which
   * the single `UPDATE` guarantees whatever the clock says. The alternative,
   * raw `UPDATE ... WHERE "expiresAt" > now() RETURNING ...`, buys the database
   * as sole clock authority at the price of hand-written SQL with quoted
   * camelCase identifiers and untyped result rows.
   */
  async consume(input: ConsumeTokenInput): Promise<ConsumedToken | null> {
    const { purpose } = input;
    const tokenHash = hashSecretToken(input.token);
    const consumedAt = new Date();

    const { count } = await this.store.verificationToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: consumedAt } },
      data: { consumedAt },
    });
    if (count !== 1) return null;

    const row = await this.store.verificationToken.findUnique({ where: { tokenHash } });
    if (row === null) return null;

    return { userId: row.userId, purpose, consumedAt };
  }
}
