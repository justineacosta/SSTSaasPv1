### Task 10: `apps/api` — Redis sliding-window rate limiting

**Files:**
- Create: `apps/api/src/common/guards/rate-limit.config.ts`, `apps/api/src/common/guards/rate-limit.guard.ts`, `apps/api/src/common/guards/sliding-window.ts`, `apps/api/src/common/decorators/rate-limit.decorator.ts`
- Test: `apps/api/src/common/guards/rate-limit.config.spec.ts`, `apps/api/src/common/guards/rate-limit.integration.spec.ts`

**Interfaces:**
- Consumes: the Redis client from Task 9's `RedisModule`; `DomainError` (Task 9)
- Produces:
  - `RATE_LIMIT_CLASSES` — the table from `abuse-prevention.md` §1 as configuration
  - `type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES`
  - `@RateLimit(className: RateLimitClass)`
  - `RateLimitGuard` — sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and throws `DomainError(RATE_LIMITED, …, 429)` with `Retry-After`

- [ ] **Step 1: Write the config and its unit test**

`rate-limit.config.ts` transcribes `abuse-prevention.md` §1 verbatim:
```ts
export interface Window {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitClassConfig {
  readonly perIp?: Window;
  readonly perPrincipal?: Window;
  readonly perOrganization?: Window;
  /**
   * What to do when Redis is unavailable.
   *
   * 'closed' on authentication endpoints: a Redis outage must not become a
   * window for credential stuffing. 'open' on read-only endpoints: an outage
   * should not lock every customer out of reading their own data.
   * See abuse-prevention.md §1.
   */
  readonly failMode: 'open' | 'closed';
}

export const RATE_LIMIT_CLASSES = {
  login: {
    perPrincipal: { limit: 5, windowSeconds: 900 },
    perIp: { limit: 20, windowSeconds: 900 },
    failMode: 'closed',
  },
  registration: { perIp: { limit: 3, windowSeconds: 3600 }, failMode: 'closed' },
  passwordReset: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    perIp: { limit: 10, windowSeconds: 3600 },
    failMode: 'closed',
  },
  emailVerificationResend: {
    perPrincipal: { limit: 3, windowSeconds: 3600 },
    failMode: 'closed',
  },
  invitations: { perOrganization: { limit: 50, windowSeconds: 86_400 }, failMode: 'closed' },
  scanCreate: { perOrganization: { limit: 10, windowSeconds: 60 }, failMode: 'closed' },
  evidenceUpload: { perOrganization: { limit: 100, windowSeconds: 3600 }, failMode: 'closed' },
  reportGeneration: { perOrganization: { limit: 10, windowSeconds: 3600 }, failMode: 'closed' },
  generalSession: { perPrincipal: { limit: 1000, windowSeconds: 60 }, failMode: 'open' },
  generalApiKey: { perPrincipal: { limit: 600, windowSeconds: 60 }, failMode: 'open' },
} as const satisfies Record<string, RateLimitClassConfig>;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;
```

`rate-limit.config.spec.ts`:
```ts
describe('RATE_LIMIT_CLASSES', () => {
  it('declares at least one window for every class', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      const windows = [config.perIp, config.perPrincipal, config.perOrganization].filter(Boolean);
      expect(windows.length, name).toBeGreaterThan(0);
    }
  });

  it('uses positive limits and windows throughout', () => {
    for (const [name, config] of Object.entries(RATE_LIMIT_CLASSES)) {
      for (const window of [config.perIp, config.perPrincipal, config.perOrganization]) {
        if (window === undefined) continue;
        expect(window.limit, name).toBeGreaterThan(0);
        expect(window.windowSeconds, name).toBeGreaterThan(0);
      }
    }
  });

  it('fails closed on every authentication class', () => {
    for (const name of ['login', 'registration', 'passwordReset', 'emailVerificationResend'] as const) {
      expect(RATE_LIMIT_CLASSES[name].failMode, name).toBe('closed');
    }
  });

  it('fails open on the general read classes', () => {
    expect(RATE_LIMIT_CLASSES.generalSession.failMode).toBe('open');
    expect(RATE_LIMIT_CLASSES.generalApiKey.failMode).toBe('open');
  });
});
```

Only `generalSession`, `generalApiKey`, `login`, and `registration` are reachable in Phase 1;
the rest are configuration waiting for their endpoints. The test above asserts every class is
well-formed so a typo cannot lie dormant until Phase 10.

- [ ] **Step 2: Write the failing integration test**

`rate-limit.integration.spec.ts`, against a real Redis in Testcontainers:
```ts
describe('rate limiting', () => {
  it('allows requests up to the limit and returns 429 on the next one');
  it('returns the shared error envelope with code RATE_LIMITED on the 429');
  it('sets RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset on every response');
  it('sets Retry-After on the 429');
  it('counts per IP and per principal independently — exhausting one does not exhaust the other');
  it('lets the window slide: a request older than windowSeconds no longer counts');
  it('applies the per-class limit, not one global limit');

  // The two that are the point of this task.
  it('FAILS CLOSED on an authentication class when Redis is unavailable', async () => {
    await redisContainer.stop();
    await request(server).post('/api/v1/__test/login-class').expect(429);
  });

  it('FAILS OPEN on a read-only class when Redis is unavailable', async () => {
    await redisContainer.stop();
    await request(server).get('/api/v1/__test/general-class').expect(200);
  });
});
```

Getting those last two backwards is either a site-wide lockout during a Redis blip or an open
window for credential stuffing, which is why they are asserted rather than assumed. The
`__test` routes are registered only when `APP_ENV === 'test'`.

- [ ] **Step 3: Implement**

`sliding-window.ts` — one Redis sorted set per key
(`ratelimit:{class}:{scope}:{identifier}`), and a single `MULTI` performing
`ZREMRANGEBYSCORE` (drop entries older than the window), `ZCARD` (count what remains),
`ZADD` (record this request), and `EXPIRE` (bound memory). One round trip, atomic under
concurrency — a read-then-write would let two simultaneous requests both see room.

`rate-limit.guard.ts` — resolves the class from decorator metadata (defaulting to
`generalSession`), evaluates every configured scope, sets the headers from the tightest
remaining window, and on breach throws:
```ts
throw new DomainError(ERROR_CODES.RATE_LIMITED, 'Too many requests. Try again shortly.', 429, {
  retryAfterSeconds,
});
```
On a Redis error it consults `failMode` and either allows or throws — and logs at `warn` either
way, because a rate limiter that has silently stopped limiting is worth knowing about.

- [ ] **Step 4: Run, verify, commit**

```bash
pnpm test && pnpm test:integration
git add -A
git commit -m "$(cat <<'EOF'
feat(api): Redis sliding-window rate limiting, per IP and per principal

One atomic sorted-set window per limit class, with RateLimit-Limit,
RateLimit-Remaining and RateLimit-Reset on every response and Retry-After on
the 429. The whole window operation is a single MULTI: a read-then-write
would let two simultaneous requests both see room.

Fails CLOSED on authentication classes and OPEN on read-only ones when Redis
is unavailable, both asserted by stopping the container mid-test. A Redis
blip must not lock customers out of reading their own data, and it must not
become a credential-stuffing window either.

Limit classes transcribe abuse-prevention.md §1 in full. Classes whose
endpoints arrive in later phases are still asserted well-formed, so a typo
cannot lie dormant until Phase 10.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

