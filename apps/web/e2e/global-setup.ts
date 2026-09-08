import { apiEnvSchema, loadEnv } from '@sentinel/config';
import Redis from 'ioredis';

/**
 * Clears the rate limiter's counters before the suite runs.
 *
 * # Why this is necessary, and why it is not cheating
 *
 * `registration` is limited to **3 per IP per hour**
 * (`apps/api/src/common/guards/rate-limit.config.ts`). The journey registers
 * two accounts, so the first run of an hour succeeds and the second is refused
 * — measured, not predicted: the second run of the journey failed at step 1
 * with "Too many requests. Try again shortly." That is the product behaving
 * exactly as designed, and it makes the suite unrepeatable without this.
 *
 * It also breaks CI on its own terms rather than only locally. `retries: 2` is
 * set for CI, and a `describe.serial` block is retried whole — so a single
 * flake would replay the registrations and the retry would fail for a reason
 * that has nothing to do with the original failure, which is the worst possible
 * diagnostic.
 *
 * **The alternative was raising the limits under `APP_ENV=test`, and it was
 * rejected.** The E2E environment is the one that is meant to resemble
 * production most closely; a limit that is loosened exactly where it is
 * exercised is a limit no test has ever watched refuse anything. Resetting the
 * counters before the run leaves every limit at its real value *during* the
 * run, so the limiter still guards every request the journey makes, and the
 * failure-path specs can still drive a limit to its refusal on purpose.
 *
 * # What it deletes, and what it does not
 *
 * Only keys matching `ratelimit:*`, scanned rather than matched with `KEYS` so
 * a large keyspace is not blocked. Sessions, cached session documents and every
 * other key are untouched. This Redis is shared with ordinary development, so
 * the blast radius being small is the point — the cost of this reset to a
 * developer is that their own rate-limit counters restart, which is not a cost.
 */
export default async function globalSetup(): Promise<void> {
  // The API's schema rather than the e2e one: `REDIS_URL` is an API setting,
  // and this is reaching the API's own store.
  const { REDIS_URL } = loadEnv(apiEnvSchema);
  const redis = new Redis(REDIS_URL);

  try {
    let cursor = '0';
    let deleted = 0;

    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'ratelimit:*', 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) deleted += await redis.del(...keys);
    } while (cursor !== '0');

    // Deliberately not silent. A reader looking at why a run behaved
    // differently from the last one should be able to see that this happened.
    process.stdout.write(`[e2e] cleared ${String(deleted)} rate-limit counters\n`);
  } finally {
    await redis.quit();
  }
}
