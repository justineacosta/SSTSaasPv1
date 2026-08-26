import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@sentinel/observability';
import type { Redis } from 'ioredis';
import { LOGGER, REDIS } from '../../infrastructure/tokens.js';

/**
 * THE SESSION LOOKUP CACHE, AS A PORT WITH THREE OPERATIONS AND ONE INVARIANT.
 *
 * ADR-0005 rejects JWTs and then owes an answer to the objection it invites —
 * "that is a database lookup per request" — and the answer it gives is this
 * cache, with the promise that **revocation deletes the cache entry and the row
 * together, so revocation is genuinely immediate**. That promise is what shapes
 * this file. It is not a generic key/value helper.
 *
 * **THE INVARIANT: a tombstone can never be overwritten by a live entry.**
 *
 * Consider the ordinary design — revocation `DEL`s the key and updates the row;
 * a resolve that misses reads Postgres and `SET`s what it found. Interleave
 * them: the resolve reads a still-live row, revocation `DEL`s and commits, and
 * *then* the resolve's `SET` lands. The cache now holds a live entry for a
 * revoked session and serves it until the TTL expires. Reversing the two halves
 * of revocation does not help — it moves the window, it does not close it —
 * which matters because "delete the cache entry first" is easy to write down as
 * though it were the control, and it is not.
 *
 * So revocation writes a **tombstone** rather than deleting, and every live
 * write goes through a Lua script that refuses to run over one. Redis executes
 * a script atomically (single-threaded, no interleaving inside `EVAL`), so
 * there is a total order between "the tombstone was written" and "the live
 * write's GET": either the script ran first and revocation overwrites it, or
 * the script sees the tombstone and writes nothing. There is no third case.
 *
 * **What this does NOT close, stated plainly.** If Redis is unreachable *at the
 * moment of revocation*, no tombstone is written; the row is revoked, but an
 * entry cached before the outage keeps serving until it expires on its own.
 * `SESSION_CACHE_TTL_SECONDS` is the bound on that window, and it is the reason
 * that variable is short and configurable. Nothing here can do better: the
 * component that would have to be told is the one that is down.
 *
 * **Every operation swallows a Redis failure and reports it in the return
 * value.** A cache is an optimisation; an outage must degrade to Postgres, not
 * to a failure (ADR-0005, Consequences). `read` returns `null` — the same as a
 * miss, which is the correct handling — and the two writes return `false`.
 * `SessionService` decides what a `false` means, and for revocation it means a
 * warning is logged, because that is the residual above.
 */
export interface SessionCache {
  /** The cached entry, or `null` for a miss **or** an unreachable Redis. */
  read(key: string): Promise<string | null>;
  /**
   * Writes a live entry unless a tombstone holds the key.
   *
   * `false` means the entry was not written: the session has been revoked, or
   * Redis is unreachable. Neither is an error for the caller — the answer it is
   * about to return came from Postgres either way.
   */
  writeLive(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Poisons the key so no live entry can occupy it until the TTL expires.
   *
   * `false` means Redis is unreachable, which is the one residual named above.
   */
  writeTombstone(key: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * The value a poisoned key holds.
 *
 * Deliberately not valid JSON for the live payload: even if the atomicity
 * argument above were wrong, a tombstone read by the parser fails its schema
 * rather than being mistaken for a session.
 */
export const SESSION_TOMBSTONE = 'revoked';

/**
 * `GET`-then-`SET` as one atomic step.
 *
 * `SET ... NX` would also refuse to overwrite a tombstone, but it would equally
 * refuse to refresh a live entry — and a refresh is exactly what rolling
 * renewal needs, because an entry cached just before `lastSeenAt` moved holds
 * an `idleExpiresAt` that is about to pass. Serving that would log an active
 * user out one minute after renewing their session. So the condition has to be
 * "not a tombstone" rather than "not present", and that is one comparison Redis
 * has no single command for.
 *
 * `KEYS[1]` rather than an interpolated key, so the script is cluster-correct
 * and carries no injection surface.
 */
const WRITE_LIVE_UNLESS_TOMBSTONED = `
if redis.call('GET', KEYS[1]) == ARGV[3] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

@Injectable()
export class RedisSessionCache implements SessionCache {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The failure log names the operation and carries the error, and **never the
   * key**.
   *
   * The key embeds the session's `tokenHash`. That is not a credential — the
   * raw token is, and SHA-256 does not run backwards — but a 64-character hex
   * string in a log line is indistinguishable from one to every secret scanner
   * this repository has already been failed by (`scripts/check-secret-shaped-
   * literals.ts` documents four such pull requests), and it buys an operator
   * nothing they could act on. The error object still goes through the
   * redacting `err` serialiser, which matters because ioredis puts the
   * connection URL, credentials and all, into its own error text.
   */
  private failed(operation: string, error: unknown): void {
    this.logger.warn({ err: error, operation }, 'Session cache operation failed');
  }

  async read(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.failed('read', error);
      return null;
    }
  }

  async writeLive(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const written = await this.redis.eval(
        WRITE_LIVE_UNLESS_TOMBSTONED,
        1,
        key,
        value,
        String(ttlSeconds),
        SESSION_TOMBSTONE,
      );
      return written === 1;
    } catch (error) {
      this.failed('writeLive', error);
      return false;
    }
  }

  async writeTombstone(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      // Unconditional: a tombstone overwrites whatever is there, including a
      // live entry written a microsecond earlier. That direction is the whole
      // point — revocation must win every race it is in.
      await this.redis.set(key, SESSION_TOMBSTONE, 'EX', ttlSeconds);
      return true;
    } catch (error) {
      this.failed('writeTombstone', error);
      return false;
    }
  }
}
