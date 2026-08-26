import { Inject, Injectable } from '@nestjs/common';
import { organizationIdSchema, sessionIdSchema, userIdSchema } from '@sentinel/contracts';
import { newId } from '@sentinel/db';
import type { Logger } from '@sentinel/observability';
import { z } from 'zod';
import { LOGGER } from '../../infrastructure/tokens.js';
import { SESSION_CACHE, SESSION_POLICY } from './auth.tokens.js';
import { SESSION_TOMBSTONE, type SessionCache } from './session.cache.js';
import {
  SESSION_STATUSES,
  type SessionCreateData,
  SessionRepository,
  type SessionRow,
  type SessionStatus,
} from './session.repository.js';
import { hashSecretToken, mintSecretToken } from './secret-token.js';

const MILLISECONDS = 1_000;

/**
 * The five durations `security/authentication.md` §3 and §5 imply, in seconds.
 *
 * Provided rather than read from `ApiEnv` directly so a spec can construct a
 * policy the configuration layer would refuse — a lifetime that has already
 * elapsed, which is how the two expiry clocks are tested independently below.
 * `token.service.integration.spec.ts` uses the same device for the same reason.
 */
export interface SessionPolicy {
  readonly absoluteLifetimeSeconds: number;
  readonly rememberMeLifetimeSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly pendingMfaLifetimeSeconds: number;
  readonly cacheTtlSeconds: number;
}

/**
 * The Redis namespace for session cache entries, and nothing else's.
 *
 * Carry-forward ruling 33: the integration suite runs sequentially against one
 * shared compose Redis, and two suites already collide over `ratelimit:`. A
 * prefix nothing else uses is what lets a spec clean up by key instead of
 * reaching for `FLUSHDB`, which would delete the rate-limit specs' buckets out
 * from under them.
 *
 * `v1` is in the key, not in the payload, because a payload shape change would
 * otherwise have to be readable by both versions during a rolling deploy. A new
 * version number simply misses, falls back to Postgres, and repopulates.
 */
export const SESSION_CACHE_KEY_PREFIX = 'session:v1:';

/**
 * The key is derived from the **hash**, never the raw token.
 *
 * Redis is not the system of record and its keyspace is readable by anything
 * with a connection — `KEYS`, `SCAN`, `MONITOR`, an `--rdb` dump. A raw token
 * in a key would be a credential sitting in plaintext in a component whose
 * whole purpose is to be fast rather than to be a vault, and it would defeat
 * the point of storing only a hash in Postgres.
 */
export function sessionCacheKey(tokenHash: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${tokenHash}`;
}

/**
 * §3's absolute lifetime: 7 days, 30 with "remember me" — and §5's much shorter
 * one for the session that has proved a password and not a factor.
 *
 * The `PENDING_MFA` arm comes first and ignores `rememberMe` entirely. A
 * pending session is not a session the user asked to be remembered; it is a
 * few minutes of permission to type six digits, and "remember me" arriving on
 * the login request that created it must not turn it into a thirty-day
 * password-only credential.
 */
export function absoluteLifetimeSeconds(
  policy: SessionPolicy,
  input: { status: SessionStatus; rememberMe: boolean },
): number {
  if (input.status === 'PENDING_MFA') return policy.pendingMfaLifetimeSeconds;
  return input.rememberMe ? policy.rememberMeLifetimeSeconds : policy.absoluteLifetimeSeconds;
}

/**
 * §3's "rolling renewal past the halfway mark", as a pure function.
 *
 * The halfway mark is what stops an authenticated **read** from being a
 * database **write**. Renewing on every request would put an `UPDATE` on the
 * hot path of every page load, every poll and every SSE reconnect, which is the
 * cost ADR-0005 spends the Redis cache to avoid — and then hands straight back.
 * Half the idle window is the standard trade: nobody is ever logged out for
 * want of a renewal (the next request past the mark renews, and every request
 * before it leaves at least half the window in hand), and the write rate falls
 * by whatever ratio the user's request interval bears to twelve hours.
 */
export function isRenewalDue(input: {
  lastSeenAt: Date;
  now: Date;
  idleTimeoutSeconds: number;
}): boolean {
  const elapsedSeconds = (input.now.getTime() - input.lastSeenAt.getTime()) / MILLISECONDS;
  return elapsedSeconds >= input.idleTimeoutSeconds / 2;
}

/**
 * `User-Agent` is the one column in this table an attacker chooses.
 *
 * It is recorded for `/settings/security`'s session list (§3), which means it
 * reaches a browser in Task 17. Capping it here — at the boundary where it is
 * written, not at the boundary where it is displayed — is what stops a
 * megabyte header becoming a megabyte row, and it is not the escaping; that is
 * still owed by whatever renders it.
 *
 * 512 is chosen, not quoted: the longest `User-Agent` strings in ordinary
 * circulation are around 200 characters, so this is generous enough that no
 * real client is truncated and small enough that the column cannot be used as
 * storage.
 */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * 45 characters is the longest possible textual IPv6 address (an IPv4-mapped
 * form such as `0000:...:255.255.255.255`).
 *
 * A longer value is **not** truncated, it is recorded as `NULL`. Truncating
 * would write a different address than the one that connected, and this column
 * exists to be read during an incident; a wrong address in an incident record
 * is worse than an absent one. It is not refused either — an unparseable
 * forwarded header must not be able to fail a login.
 */
export const IP_MAX_LENGTH = 45;

const ipInput = z
  .string()
  .nullable()
  .default(null)
  .transform((value) =>
    value === null || value.length === 0 || value.length > IP_MAX_LENGTH ? null : value,
  );

const userAgentInput = z
  .string()
  .nullable()
  .default(null)
  .transform((value) =>
    value === null || value.length === 0 ? null : value.slice(0, USER_AGENT_MAX_LENGTH),
  );

/**
 * Zod at the boundary, on a call that never crosses the network.
 *
 * `issue` is invoked by our own handlers, so the types would already be right
 * if types were validation — the core rules say they are not, and two of these
 * fields are the reason. `ip` and `userAgent` originate in request headers, and
 * `userId` will one day be passed by a caller that took it from somewhere it
 * should not have. `.strict()` for `api/conventions.md` §3's reason: an
 * unrecognised field is a mistake, not something to ignore.
 *
 * **`status` has no default, and that is carry-forward ruling 6.**
 * `Session.status` has no `@default` in `schema.prisma` so that forgetting it
 * is a compile error rather than a silently privileged session. A default here
 * would put the omission back, one layer up, and this is the layer every caller
 * goes through.
 */
const issueSessionInputSchema = z
  .object({
    userId: userIdSchema,
    status: z.enum(SESSION_STATUSES),
    rememberMe: z.boolean().default(false),
    activeOrganizationId: organizationIdSchema.nullable().default(null),
    mfaCompletedAt: z.date().nullable().default(null),
    ip: ipInput,
    userAgent: userAgentInput,
  })
  .strict();

export type IssueSessionInput = z.input<typeof issueSessionInputSchema>;

const rotateSessionInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    /** The successor's status. `ACTIVE` unless a caller says otherwise. */
    status: z.enum(SESSION_STATUSES).default('ACTIVE'),
    activeOrganizationId: organizationIdSchema.nullable().optional(),
    mfaCompletedAt: z.date().nullable().optional(),
    ip: ipInput,
    userAgent: userAgentInput,
  })
  .strict();

export type RotateSessionInput = z.input<typeof rotateSessionInputSchema>;

/**
 * A session as the rest of the application sees it.
 *
 * No `tokenHash`, and no raw token. Task 7 turns this into a `UserPrincipal`,
 * which carries `userId` and `sessionId` and nothing else
 * (`packages/contracts/src/principal.ts`).
 */
export interface ResolvedSession {
  readonly id: string;
  readonly userId: string;
  readonly status: SessionStatus;
  readonly activeOrganizationId: string | null;
  readonly rememberMe: boolean;
  readonly absoluteExpiresAt: Date;
  readonly idleExpiresAt: Date;
  readonly lastSeenAt: Date;
  readonly mfaCompletedAt: Date | null;
}

export interface IssuedSession {
  readonly session: ResolvedSession;
  /**
   * The raw token, returned exactly once, for the cookie.
   *
   * It exists nowhere else: not in the row, not in a log, not in an
   * `AuditEvent`, and not in a second call. Named `token` deliberately — the
   * redacting logger matches `token` as a key-name fragment
   * (`packages/observability/src/redaction.ts`), so an accidental
   * `logger.info({ ...issued })` is redacted structurally rather than relying
   * on a value-shape heuristic to notice.
   */
  readonly token: string;
  /**
   * What `serialiseSessionCookie` should be given, computed here so no caller
   * repeats the subtraction.
   *
   * `null` for a session the user did not ask to be remembered, which makes the
   * cookie a browser-session cookie. See `cookies.ts` for why that is the
   * honest rendering of "remember me" and why the cookie is never the authority
   * on lifetime.
   */
  readonly cookieMaxAgeSeconds: number | null;
}

/**
 * WHY A REFUSAL HAS A REASON RATHER THAN BEING `null`.
 *
 * `api/authentication.md` §6 gives Task 7 two distinct codes, and
 * `security/authorization.md` a third: `UNAUTHENTICATED` for a credential that
 * means nothing, `SESSION_EXPIRED` for one that used to, and `MFA_REQUIRED` for
 * a pending session that has not finished. They are distinct because they tell
 * the frontend whether to show "log in" or "your session ended" — and a service
 * returning `null` would force the guard to invent that distinction, or to drop
 * it.
 *
 * This is **not** an account oracle. Reaching `expired` or `revoked` requires
 * already holding a token that was genuinely issued; an attacker guessing
 * 256-bit values gets `unknown` every time.
 *
 * `resolved` carries the status rather than splitting into two arms, because
 * "is this session allowed to reach this route" is authorization, and that is
 * Task 7's to decide, not this service's.
 */
export type SessionResolution =
  | { readonly outcome: 'resolved'; readonly session: ResolvedSession }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'revoked' };

/**
 * The cached snapshot's wire form.
 *
 * Redis content is **external input** — another process writes this keyspace,
 * the value survives a deploy that changed the shape, and an operator can set
 * anything with `redis-cli`. So it is parsed, not cast. A payload that fails
 * this schema is treated as a cache miss and the request falls through to
 * Postgres, which is the only source that was ever authoritative.
 *
 * Dates travel as ISO strings because that is what `JSON.stringify` does to a
 * `Date` anyway; making it explicit is what lets the schema check them.
 */
const cachedSessionSchema = z
  .object({
    v: z.literal(1),
    id: sessionIdSchema,
    userId: userIdSchema,
    status: z.enum(SESSION_STATUSES),
    activeOrganizationId: z.string().nullable(),
    rememberMe: z.boolean(),
    absoluteExpiresAt: z.string().datetime(),
    idleExpiresAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    mfaCompletedAt: z.string().datetime().nullable(),
  })
  .strict();

function encodeCached(session: ResolvedSession): string {
  return JSON.stringify({
    v: 1,
    id: session.id,
    userId: session.userId,
    status: session.status,
    activeOrganizationId: session.activeOrganizationId,
    rememberMe: session.rememberMe,
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    mfaCompletedAt: session.mfaCompletedAt?.toISOString() ?? null,
  });
}

function decodeCached(raw: string): ResolvedSession | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const parsed = cachedSessionSchema.safeParse(candidate);
  if (!parsed.success) return undefined;

  const value = parsed.data;
  return {
    id: value.id,
    userId: value.userId,
    status: value.status,
    activeOrganizationId: value.activeOrganizationId,
    rememberMe: value.rememberMe,
    absoluteExpiresAt: new Date(value.absoluteExpiresAt),
    idleExpiresAt: new Date(value.idleExpiresAt),
    lastSeenAt: new Date(value.lastSeenAt),
    mfaCompletedAt: value.mfaCompletedAt === null ? null : new Date(value.mfaCompletedAt),
  };
}

function toResolved(row: SessionRow): ResolvedSession {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    activeOrganizationId: row.activeOrganizationId,
    rememberMe: row.rememberMe,
    absoluteExpiresAt: row.absoluteExpiresAt,
    idleExpiresAt: row.idleExpiresAt,
    lastSeenAt: row.lastSeenAt,
    mfaCompletedAt: row.mfaCompletedAt,
  };
}

/**
 * BOTH CLOCKS, CHECKED SEPARATELY, EVERY TIME.
 *
 * `schema.prisma`'s comment on the model is the argument: a single `expiresAt`
 * can only be one of these, and whichever one it is, the other silently stops
 * being enforced. Checking the absolute clock first is not an optimisation —
 * it is the one that can never be moved by activity, so it is the one a
 * long-lived stolen token runs into.
 */
function expiryOf(session: ResolvedSession, now: Date): SessionResolution | undefined {
  if (session.absoluteExpiresAt.getTime() <= now.getTime()) return { outcome: 'expired' };
  if (session.idleExpiresAt.getTime() <= now.getTime()) return { outcome: 'expired' };
  return undefined;
}

/**
 * LAYER 3 OF THE TOKEN DISCIPLINE: THE SESSION MACHINE.
 *
 * `secret-token.ts` mints and hashes; `session.repository.ts` writes rows;
 * this class owns the policy — how long a session lives, when its idle clock
 * moves, what rotation inherits, what revocation has to reach, and what the
 * cache is allowed to answer.
 *
 * **Nothing here is reachable over the network.** `AuthModule` registers no
 * controller, and `pnpm check:openapi` still reports four routes with this
 * service in it. Task 7 builds the guard that calls `resolve`; Task 9 the login
 * that calls `issue`; Tasks 10, 11, 13 and 14 the privilege changes that call
 * `rotate` and the two bulk revocations.
 *
 * **It does not decide whether a user is allowed to have a session.**
 * Carry-forward rulings 37 and 38 put the equivalent responsibilities on the
 * endpoint for `TokenService`, and this service is the same kind of object: it
 * checks no `User.status` and writes no `AuditEvent`. Task 9 owns refusing a
 * `LOCKED` user, and burying that check here would give Task 9 two places to
 * look with one of them silent. `AuditEvent.organizationId` is NOT NULL with a
 * `Restrict` foreign key, and a session can exist before its user has chosen an
 * organisation, so the event is the endpoint's to write.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    @Inject(SESSION_CACHE) private readonly cache: SessionCache,
    @Inject(SESSION_POLICY) private readonly policy: SessionPolicy,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Mints a session and returns its raw token exactly once.
   *
   * **The cache is deliberately not warmed here.** The credential has not been
   * presented yet, so a cache entry written now saves at most one Postgres read
   * and costs a Redis write on the login path — and it would have to be written
   * through the tombstone-aware script anyway, for a key that cannot yet have a
   * tombstone. The first `resolve` populates it.
   *
   * The idle clock is clamped to the absolute one. Nothing depends on that —
   * `expiryOf` checks both independently — but a row whose idle expiry sits
   * past its absolute expiry states something that is not true about the
   * session, and this table is read during incidents.
   */
  async issue(input: IssueSessionInput): Promise<IssuedSession> {
    const parsed = issueSessionInputSchema.parse(input);
    const minted = mintSecretToken();
    const now = new Date();

    const absoluteExpiresAt = new Date(
      now.getTime() + absoluteLifetimeSeconds(this.policy, parsed) * MILLISECONDS,
    );
    const idleExpiresAt = this.idleExpiryFrom(now, absoluteExpiresAt);

    const data: SessionCreateData = {
      id: newId('ses'),
      userId: parsed.userId,
      tokenHash: minted.tokenHash,
      status: parsed.status,
      idleExpiresAt,
      absoluteExpiresAt,
      lastSeenAt: now,
      rememberMe: parsed.rememberMe,
      activeOrganizationId: parsed.activeOrganizationId,
      ip: parsed.ip,
      userAgent: parsed.userAgent,
      mfaCompletedAt: parsed.mfaCompletedAt,
      rotatedFromId: null,
    };
    await this.repository.create(data);

    return this.issued(data, minted.token, now);
  }

  /**
   * Resolves a raw token to a session, or says why not.
   *
   * The order — cache, then Postgres — is ADR-0005's answer to "that is a
   * database lookup per request". What makes it safe is in `session.cache.ts`:
   * a revoked key holds a tombstone that no live write can overwrite, so a hit
   * can never be a session Postgres has since revoked.
   *
   * A cached payload that does not parse is treated as a miss rather than as an
   * error. The only authority was always Postgres; falling through costs one
   * read and cannot answer wrongly.
   */
  async resolve(token: string): Promise<SessionResolution> {
    const tokenHash = hashSecretToken(token);
    const key = sessionCacheKey(tokenHash);
    const now = new Date();

    const cached = await this.cache.read(key);
    if (cached === SESSION_TOMBSTONE) return { outcome: 'revoked' };

    if (cached !== null) {
      const snapshot = decodeCached(cached);
      if (snapshot !== undefined) {
        const expired = expiryOf(snapshot, now);
        if (expired !== undefined) return expired;

        const due = isRenewalDue({
          lastSeenAt: snapshot.lastSeenAt,
          now,
          idleTimeoutSeconds: this.policy.idleTimeoutSeconds,
        });
        if (!due) return { outcome: 'resolved', session: snapshot };

        // Past the halfway mark the idle clock has to move in Postgres, and
        // that write doubles as a liveness check the cache cannot perform. If
        // it reports no live row, this request has nothing trustworthy left and
        // re-reads Postgres for an accurate answer rather than guessing which
        // refusal applies.
        const renewed = await this.renew(snapshot, now);
        if (renewed === undefined) return this.resolveFromDatabase(tokenHash, key, now);

        await this.cache.writeLive(key, encodeCached(renewed), this.policy.cacheTtlSeconds);
        return { outcome: 'resolved', session: renewed };
      }
    }

    return this.resolveFromDatabase(tokenHash, key, now);
  }

  private async resolveFromDatabase(
    tokenHash: string,
    key: string,
    now: Date,
  ): Promise<SessionResolution> {
    const row = await this.repository.findByTokenHash(tokenHash);
    if (row === null) return { outcome: 'unknown' };
    if (row.revokedAt !== null) return { outcome: 'revoked' };

    const session = toResolved(row);
    const expired = expiryOf(session, now);
    if (expired !== undefined) return expired;

    // Renewal before the cache write, never after. Writing first would cache
    // the `idleExpiresAt` that is about to be replaced — for a session arriving
    // just past its halfway mark that value can be minutes from passing, and
    // the next request inside the cache TTL would read it as expired and log
    // out a user who had just been renewed.
    const renewed = await this.renew(session, now);
    if (renewed === undefined) return { outcome: 'revoked' };

    await this.cache.writeLive(key, encodeCached(renewed), this.policy.cacheTtlSeconds);
    return { outcome: 'resolved', session: renewed };
  }

  /**
   * Moves the idle clock if it is due, and reports the session as it now
   * stands. `undefined` means the row is no longer live.
   */
  private async renew(session: ResolvedSession, now: Date): Promise<ResolvedSession | undefined> {
    const due = isRenewalDue({
      lastSeenAt: session.lastSeenAt,
      now,
      idleTimeoutSeconds: this.policy.idleTimeoutSeconds,
    });
    if (!due) return session;

    const idleExpiresAt = this.idleExpiryFrom(now, session.absoluteExpiresAt);
    const live = await this.repository.touch({ id: session.id, lastSeenAt: now, idleExpiresAt });
    if (!live) return undefined;

    return { ...session, lastSeenAt: now, idleExpiresAt };
  }

  /**
   * §3's session-fixation defence: every privilege change issues a new
   * credential and kills the one that came before it.
   *
   * Login, MFA completion, password change, role change — and organisation
   * switching, which Task 13 adds. Rotating means the token in the browser
   * before the privilege change cannot be used after it, which is what stops an
   * attacker who planted a session value from riding the victim's escalation.
   *
   * **The absolute clock is inherited, not restarted.** §3 says the absolute
   * lifetime never moves, and a rotation that reset it would let a user hold a
   * session indefinitely by changing their password once a week — the cap would
   * exist and bound nothing. The one exception is the `PENDING_MFA` -> `ACTIVE`
   * transition: the pending session's clock is §5's few minutes to type a code,
   * it was never the user's session lifetime, and inheriting it would expire
   * the real session moments after MFA succeeded.
   *
   * **The cache is poisoned before the transaction, and it stays poisoned even
   * if the transaction then fails.** That is fail-closed and it is the direction
   * that matters: the alternative — poison after commit — leaves the old token
   * servable from cache for the width of the commit. The cost is that a
   * rotation which fails on a database error signs the user out for at most
   * `SESSION_CACHE_TTL_SECONDS`, and the benefit is that a rotated-away
   * credential is never live anywhere.
   *
   * Returns `null` when there was nothing to rotate: no such session, already
   * revoked, already past either clock, or a concurrent rotation won the race.
   * Exactly one of two concurrent rotations returns a session; see
   * `session.repository.ts`'s `rotate` for why the affected-row count is
   * sufficient here where `TokenService.issue` needed an advisory lock.
   */
  async rotate(input: RotateSessionInput): Promise<IssuedSession | null> {
    const parsed = rotateSessionInputSchema.parse(input);
    const predecessor = await this.repository.findById(parsed.sessionId);
    if (predecessor === null || predecessor.revokedAt !== null) return null;

    const now = new Date();
    if (expiryOf(toResolved(predecessor), now) !== undefined) return null;

    const startsRealSession = predecessor.status === 'PENDING_MFA' && parsed.status === 'ACTIVE';
    const absoluteExpiresAt = startsRealSession
      ? new Date(
          now.getTime() +
            absoluteLifetimeSeconds(this.policy, {
              status: parsed.status,
              rememberMe: predecessor.rememberMe,
            }) *
              MILLISECONDS,
        )
      : predecessor.absoluteExpiresAt;

    const minted = mintSecretToken();
    const successor: SessionCreateData = {
      id: newId('ses'),
      userId: predecessor.userId,
      tokenHash: minted.tokenHash,
      status: parsed.status,
      idleExpiresAt: this.idleExpiryFrom(now, absoluteExpiresAt),
      absoluteExpiresAt,
      lastSeenAt: now,
      rememberMe: predecessor.rememberMe,
      activeOrganizationId:
        parsed.activeOrganizationId === undefined
          ? predecessor.activeOrganizationId
          : parsed.activeOrganizationId,
      ip: parsed.ip ?? predecessor.ip,
      userAgent: parsed.userAgent ?? predecessor.userAgent,
      mfaCompletedAt:
        parsed.mfaCompletedAt === undefined ? predecessor.mfaCompletedAt : parsed.mfaCompletedAt,
      rotatedFromId: predecessor.id,
    };

    await this.poison([predecessor.tokenHash], 'rotate');
    const rotated = await this.repository.rotate({
      currentId: predecessor.id,
      revokedAt: now,
      successor,
    });
    if (!rotated) return null;

    return this.issued(successor, minted.token, now);
  }

  /**
   * Revokes one session — logout, and every "sign this device out" in
   * `/settings/security`.
   *
   * `false` means there was nothing live to revoke, which a caller should treat
   * as success: the end state the user asked for is the end state they have.
   */
  async revoke(sessionId: string): Promise<boolean> {
    const row = await this.repository.findById(sessionIdSchema.parse(sessionId));
    if (row === null) return false;

    await this.poison([row.tokenHash], 'revoke');
    return this.repository.revokeById(row.id, new Date());
  }

  /**
   * §2 and §6: a password change or reset revokes every other session.
   *
   * `exceptSessionId` is how the user who just changed their own password keeps
   * the session they are sitting in. Omitting it revokes all of them, which is
   * what a reset does — the user completing a reset is not holding a session at
   * all, and if an attacker is, that is the session being taken away.
   *
   * **The caller owns the ordering, and it matters.** Enumerating the live rows
   * and then revoking them leaves a window in which a login can create a
   * session this call never saw, so a password change must write the new hash
   * *before* calling this, not after. Task 10 owns that; it is stated here
   * because the failure is invisible from inside this method.
   */
  async revokeAllForUser(
    userId: string,
    options: { exceptSessionId?: string | undefined } = {},
  ): Promise<number> {
    return this.revokeMany({
      userId: userIdSchema.parse(userId),
      exceptSessionId:
        options.exceptSessionId === undefined
          ? undefined
          : sessionIdSchema.parse(options.exceptSessionId),
      reason: 'revokeAllForUser',
    });
  }

  /**
   * `permissions.md` invariant 5: removing a member revokes their sessions for
   * that organisation immediately, and only for that organisation.
   *
   * A consultant with memberships in four organisations who is removed from one
   * of them must stay signed in to the other three — which is exactly why
   * `activeOrganizationId` is the filter and `userId` alone is not. Task 14
   * calls this.
   */
  async revokeAllForUserInOrganization(userId: string, organizationId: string): Promise<number> {
    return this.revokeMany({
      userId: userIdSchema.parse(userId),
      organizationId: organizationIdSchema.parse(organizationId),
      reason: 'revokeAllForUserInOrganization',
    });
  }

  private async revokeMany(input: {
    userId: string;
    organizationId?: string | undefined;
    exceptSessionId?: string | undefined;
    reason: string;
  }): Promise<number> {
    const scope = {
      userId: input.userId,
      organizationId: input.organizationId,
      exceptSessionId: input.exceptSessionId,
    };

    const live = await this.repository.listLiveForUser(scope);
    await this.poison(
      live.map((row) => row.tokenHash),
      input.reason,
    );
    return this.repository.revokeLiveForUser({ ...scope, revokedAt: new Date() });
  }

  /**
   * Poisons every affected cache key, and says so in the log if it could not.
   *
   * This is the one residual the tombstone design cannot close, and it is
   * logged rather than thrown for a reason: the alternative — failing the
   * revocation because Redis is down — means an operator containing an incident
   * cannot revoke sessions during exactly the kind of outage that tends to
   * accompany one. The row is still revoked, so every cache miss and every
   * instance with a cold cache refuses immediately; what survives is an entry
   * cached before the outage, for at most `SESSION_CACHE_TTL_SECONDS`.
   *
   * The log line carries counts and a reason, never a key. A cache key embeds a
   * `tokenHash`, and a 64-character hex string in a log line is what every
   * secret scanner this repository has been failed by is looking for.
   */
  private async poison(tokenHashes: readonly string[], reason: string): Promise<void> {
    let failures = 0;
    for (const tokenHash of tokenHashes) {
      const written = await this.cache.writeTombstone(
        sessionCacheKey(tokenHash),
        this.policy.cacheTtlSeconds,
      );
      if (!written) failures += 1;
    }

    if (failures > 0) {
      this.logger.warn(
        { reason, failures, attempted: tokenHashes.length, ttl: this.policy.cacheTtlSeconds },
        'Session cache could not be poisoned; a cached entry may serve a revoked session until it expires',
      );
    }
  }

  /** Never past the absolute clock. See `issue`. */
  private idleExpiryFrom(now: Date, absoluteExpiresAt: Date): Date {
    const idle = new Date(now.getTime() + this.policy.idleTimeoutSeconds * MILLISECONDS);
    return idle.getTime() > absoluteExpiresAt.getTime() ? absoluteExpiresAt : idle;
  }

  private issued(data: SessionCreateData, token: string, now: Date): IssuedSession {
    const session: ResolvedSession = {
      id: data.id,
      userId: data.userId,
      status: data.status,
      activeOrganizationId: data.activeOrganizationId,
      rememberMe: data.rememberMe,
      absoluteExpiresAt: data.absoluteExpiresAt,
      idleExpiresAt: data.idleExpiresAt,
      lastSeenAt: data.lastSeenAt,
      mfaCompletedAt: data.mfaCompletedAt,
    };

    return {
      session,
      token,
      cookieMaxAgeSeconds: data.rememberMe
        ? Math.floor((data.absoluteExpiresAt.getTime() - now.getTime()) / MILLISECONDS)
        : null,
    };
  }
}
