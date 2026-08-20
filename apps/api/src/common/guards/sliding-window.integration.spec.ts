import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Redis } from 'ioredis';
import { consumeSlidingWindow, slidingWindowKey } from './sliding-window.js';

loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });

let redis: Redis;

/** A key nothing else in the suite can collide with. */
const freshKey = (): string => slidingWindowKey('login', 'perIp', randomUUID());

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
  });
});

afterAll(async () => {
  await redis.quit();
});

describe('consumeSlidingWindow', () => {
  it('allows exactly `limit` requests and refuses the next one', async () => {
    const key = freshKey();
    const window = { limit: 3, windowSeconds: 60 };
    const now = Date.now();

    const decisions = [];
    for (let i = 0; i < 4; i += 1) {
      decisions.push(await consumeSlidingWindow(redis, key, window, now + i));
    }

    // The boundary in both directions: the third request is the last allowed
    // one, and the fourth is the first refused one. An off-by-one either way
    // fails here rather than shipping a limit that is really 2 or really 4.
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions[0]?.limit).toBe(3);
  });

  it('does not charge a refused request against the window', async () => {
    // A limiter that records refusals extends its own lockout: a client
    // hammering a closed door never sees it open, because every knock pushes
    // the window forward. The count must stop at the limit.
    const key = freshKey();
    const window = { limit: 2, windowSeconds: 60 };
    const now = Date.now();

    await consumeSlidingWindow(redis, key, window, now);
    await consumeSlidingWindow(redis, key, window, now);
    for (let i = 0; i < 5; i += 1) {
      await consumeSlidingWindow(redis, key, window, now);
    }

    expect(await redis.zcard(key)).toBe(2);
  });

  it('counts two requests that arrive in the same millisecond as two', async () => {
    // If the sorted-set member were the timestamp, ZADD would overwrite rather
    // than add and the effective limit would silently double under load — the
    // exact condition a rate limiter exists for.
    const key = freshKey();
    const window = { limit: 10, windowSeconds: 60 };
    const now = Date.now();

    const first = await consumeSlidingWindow(redis, key, window, now);
    const second = await consumeSlidingWindow(redis, key, window, now);

    expect(first.remaining).toBe(9);
    expect(second.remaining).toBe(8);
    expect(await redis.zcard(key)).toBe(2);
  });

  it('admits exactly `limit` of many genuinely concurrent requests', async () => {
    // Promise.all, not sequential awaits: a read-then-write limiter passes the
    // sequential version of this test and fails this one, because two callers
    // both see room before either has taken it.
    const key = freshKey();
    const window = { limit: 5, windowSeconds: 60 };
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeSlidingWindow(redis, key, window, now)),
    );

    expect(results.filter((r) => r.allowed).length).toBe(5);
    expect(await redis.zcard(key)).toBe(5);
  });

  it('lets the window slide: an entry older than the window no longer counts', async () => {
    const key = freshKey();
    const window = { limit: 2, windowSeconds: 60 };
    const start = Date.now();

    await consumeSlidingWindow(redis, key, window, start);
    await consumeSlidingWindow(redis, key, window, start);
    expect((await consumeSlidingWindow(redis, key, window, start)).allowed).toBe(false);

    // One millisecond past the window, the oldest entry falls out of it.
    const later = start + 60_000 + 1;
    expect((await consumeSlidingWindow(redis, key, window, later)).allowed).toBe(true);
  });

  it('reports a reset derived from the oldest entry, not from now', async () => {
    // `now + windowSeconds` would tell a caller who has waited 59 of 60 seconds
    // to wait another 60. The honest answer is when the oldest entry expires.
    const key = freshKey();
    const window = { limit: 1, windowSeconds: 60 };
    const start = Date.now();

    await consumeSlidingWindow(redis, key, window, start);
    const refused = await consumeSlidingWindow(redis, key, window, start + 59_000);

    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBe(1);
  });

  it('never reports a reset below one second while a request is refused', async () => {
    // `Retry-After: 0` invites an immediate retry that is certain to fail.
    const key = freshKey();
    const window = { limit: 1, windowSeconds: 60 };
    const start = Date.now();

    await consumeSlidingWindow(redis, key, window, start);
    const refused = await consumeSlidingWindow(redis, key, window, start + 59_999);

    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBeGreaterThanOrEqual(1);
  });

  it('never reports a reset longer than the window, even against a future entry', async () => {
    // An instance whose clock runs fast writes a future score. Without the clamp
    // a correct instance would advertise `skew + window` — for an hour-fast
    // clock, an hour-long wait presented as if it were policy. The clamp bounds
    // what is REPORTED; the lockout itself is real and lasts as long as the
    // skew, which is why the docblock says so rather than calling skew
    // immaterial.
    const key = freshKey();
    const window = { limit: 1, windowSeconds: 60 };
    const now = Date.now();

    await consumeSlidingWindow(redis, key, window, now + 3_600_000);
    const refused = await consumeSlidingWindow(redis, key, window, now);

    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBeLessThanOrEqual(window.windowSeconds);
    expect(refused.resetSeconds).toBeGreaterThanOrEqual(1);
  });

  it('expires the key so an idle bucket cannot leak memory forever', async () => {
    const key = freshKey();
    await consumeSlidingWindow(redis, key, { limit: 5, windowSeconds: 60 }, Date.now());

    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('keys separate scopes and classes into separate buckets', () => {
    expect(slidingWindowKey('login', 'perIp', '1.2.3.4')).toBe('ratelimit:login:perIp:1.2.3.4');
    expect(slidingWindowKey('login', 'perIp', '1.2.3.4')).not.toBe(
      slidingWindowKey('login', 'perPrincipal', '1.2.3.4'),
    );
    expect(slidingWindowKey('login', 'perIp', '1.2.3.4')).not.toBe(
      slidingWindowKey('registration', 'perIp', '1.2.3.4'),
    );
  });
});
