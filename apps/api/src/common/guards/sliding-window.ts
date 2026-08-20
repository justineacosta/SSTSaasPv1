import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RateLimitClass, RateLimitScope, Window } from './rate-limit.config.js';

/** The outcome of consuming one slot from a window. */
export interface WindowDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Slots left in this window after this request. Zero once the limit is reached. */
  readonly remaining: number;
  /** Whole seconds until the window frees a slot. At least 1 whenever a request is refused. */
  readonly resetSeconds: number;
}

/**
 * One sorted set per class, scope and identifier.
 *
 * The class is part of the key so a customer exhausting one class's budget does
 * not exhaust another's, and the scope is part of it so the per-IP and
 * per-principal windows of the same class stay independent — which is the whole
 * point of applying both (abuse-prevention.md §1: an attacker with many IPs is
 * caught by the principal limit, an unauthenticated flood by the IP limit).
 */
export function slidingWindowKey(
  className: RateLimitClass,
  scope: RateLimitScope,
  identifier: string,
): string {
  return `ratelimit:${className}:${scope}:${identifier}`;
}

/**
 * Drop what has aged out, count what remains, and take a slot only if there is
 * one — as a single Lua script.
 *
 * The plan specified a `MULTI`. A `MULTI` cannot do this correctly: whether to
 * add depends on the count, and a transaction has no way to branch on the
 * result of a command inside it. The two ways to write it with `MULTI` are both
 * wrong. Add unconditionally, and a refused request still records itself, so a
 * client hammering a closed door pushes the window forward with every knock and
 * never sees it open. Read first and add in a second round trip, and two
 * concurrent requests both see room before either has taken it — which is the
 * race the plan's own rationale says the transaction exists to prevent.
 *
 * A script is atomic in the way that actually matters here: Redis runs it to
 * completion against a single-threaded server, so the check and the write
 * cannot be interleaved, and it is still one round trip.
 *
 * `now` is supplied by the caller rather than read from Redis. That makes the
 * script deterministic and testable at arbitrary points in a window, at the
 * cost of depending on the API instances' clocks agreeing to within a fraction
 * of the window. For the shortest window in the table — 60 seconds — ordinary
 * NTP skew of a few milliseconds is immaterial. If a future window is short
 * enough for skew to matter, this should read Redis's own `TIME` instead.
 */
const CONSUME_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
local allowed = 0

if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
  allowed = 1
end

redis.call('PEXPIRE', key, windowMs)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = -1
if oldest[2] then
  oldestScore = tonumber(oldest[2])
end

return { allowed, count, tostring(oldestScore) }
`;

type ConsumeReply = [number, number, string];

export async function consumeSlidingWindow(
  redis: Redis,
  key: string,
  window: Window,
  now: number = Date.now(),
): Promise<WindowDecision> {
  const windowMs = window.windowSeconds * 1000;

  const reply = (await redis.eval(
    CONSUME_SCRIPT,
    1,
    key,
    String(now),
    String(windowMs),
    String(window.limit),
    // A unique member per request. If the member were the timestamp, two
    // requests landing in the same millisecond would collide and ZADD would
    // overwrite rather than add — silently doubling the effective limit at
    // exactly the traffic level a limiter exists to handle.
    `${now}-${randomUUID()}`,
  )) as ConsumeReply;

  const [allowedFlag, count, oldestScoreText] = reply;
  const oldestScore = Number(oldestScoreText);

  // The honest reset is when the oldest entry leaves the window, not
  // `now + windowSeconds`: a caller who has already waited 59 of 60 seconds
  // should be told to wait one more, not another sixty. Rounded up, and never
  // below one second while a request is refused, because `Retry-After: 0`
  // invites an immediate retry that is certain to fail.
  const resetMs = oldestScore < 0 ? 0 : oldestScore + windowMs - now;
  const allowed = allowedFlag === 1;
  const resetSeconds = Math.max(allowed ? 0 : 1, Math.ceil(Math.max(resetMs, 0) / 1000));

  return {
    allowed,
    limit: window.limit,
    remaining: Math.max(0, window.limit - count),
    resetSeconds,
  };
}
