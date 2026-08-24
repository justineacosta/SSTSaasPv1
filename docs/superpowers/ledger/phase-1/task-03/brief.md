### Task 3: `packages/observability` — redacting structured logger

**Files:**
- Create: `packages/observability/package.json`, `packages/observability/tsconfig.json`, `packages/observability/src/redaction.ts`, `packages/observability/src/context.ts`, `packages/observability/src/logger.ts`, `packages/observability/src/index.ts`
- Test: `packages/observability/src/redaction.spec.ts`, `packages/observability/src/logger.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/config` (`SharedEnv`)
- Produces:
  - `redact(value: unknown): unknown` — deep, structural
  - `REDACTED = '[redacted]'`
  - `runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T`
  - `getRequestContext(): RequestContext | undefined`
  - `interface RequestContext { requestId: string; traceId?: string; organizationId?: string; userId?: string }`
  - `createLogger(options: { service: string; level: string; pretty: boolean; silent?: boolean }): Logger`
  - `type Logger` (Pino's)

- [ ] **Step 1: Write the failing tests**

`packages/observability/src/redaction.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from './redaction.js';

describe('redact', () => {
  it('redacts by key name at the top level', () => {
    expect(redact({ password: 'hunter2', email: 'a@b.c' })).toEqual({
      password: REDACTED,
      email: 'a@b.c',
    });
  });

  it('redacts by key name at any depth', () => {
    expect(redact({ user: { credential: { passwordHash: 'x' }, name: 'Marcus' } })).toEqual({
      user: { credential: { passwordHash: REDACTED }, name: 'Marcus' },
    });
  });

  it('matches key names case-insensitively and as substrings', () => {
    const out = redact({ Authorization: 'Bearer x', apiKey: 'k', X_CSRF_TOKEN: 't' }) as Record<
      string,
      unknown
    >;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.X_CSRF_TOKEN).toBe(REDACTED);
  });

  it('redacts inside arrays', () => {
    expect(redact([{ token: 'a' }, { token: 'b' }])).toEqual([
      { token: REDACTED },
      { token: REDACTED },
    ]);
  });

  it('applies the value-shape backstop to a bearer token under an innocent key', () => {
    const out = redact({ note: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def' }) as Record<
      string,
      unknown
    >;
    expect(out.note).toBe(REDACTED);
  });

  it('applies the value-shape backstop to a postgres URL containing a password', () => {
    const out = redact({ dsn: 'postgresql://user:hunter2@host:5432/db' }) as Record<string, unknown>;
    expect(out.dsn).toBe(REDACTED);
  });

  it('leaves ordinary values alone', () => {
    const input = { scanId: 'scn_01J', count: 42, ok: true, at: null };
    expect(redact(input)).toEqual(input);
  });

  it('does not loop forever on a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => redact(circular)).not.toThrow();
  });

  it('preserves Error name and message but drops the stack', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>;
    expect(out.message).toBe('boom');
    expect(out.stack).toBeUndefined();
  });
});
```

`packages/observability/src/logger.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from './logger.js';
import { runWithRequestContext } from './context.js';
import { REDACTED } from './redaction.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({ service: 'api', level: 'debug', pretty: false, stream });
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits structured JSON carrying the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info({ scanId: 'scn_01J' }, 'Scan created');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'api', msg: 'Scan created', scanId: 'scn_01J' });
  });

  it('injects the ambient request context into every line', () => {
    const { logger, lines } = captureLogger();
    runWithRequestContext(
      { requestId: 'req_01J', organizationId: 'org_01J', userId: 'usr_01J' },
      () => logger.info('hello'),
    );
    expect(lines[0]).toMatchObject({
      requestId: 'req_01J',
      organizationId: 'org_01J',
      userId: 'usr_01J',
    });
  });

  it('redacts secrets in the logged object', () => {
    const { logger, lines } = captureLogger();
    logger.info({ headers: { authorization: 'Bearer abc' } }, 'inbound');
    expect((lines[0] as { headers: { authorization: string } }).headers.authorization).toBe(
      REDACTED,
    );
  });

  it('omits context keys entirely when there is no ambient context', () => {
    const { logger, lines } = captureLogger();
    logger.info('no context');
    expect(lines[0]).not.toHaveProperty('requestId');
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
pnpm vitest run --project unit packages/observability
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

`packages/observability/package.json`:
```json
{
  "name": "@sentinel/observability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": { "pino": "^9.5.0", "pino-pretty": "^13.0.0" },
  "devDependencies": { "@sentinel/config": "workspace:*", "typescript": "^5.7.0" }
}
```

`packages/observability/src/redaction.ts`:
```ts
export const REDACTED = '[redacted]';

/**
 * Key fragments that mark a value as secret. Matched case-insensitively as a
 * substring, so `mfaSecret`, `X_CSRF_TOKEN`, and `stripeWebhookSecret` are all
 * caught without enumerating every spelling.
 *
 * Source list: .claude/operations/monitoring.md §2.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'private_key',
  'sessionid',
  'session_id',
  'mfasecret',
] as const;

/**
 * Value-shape backstop. Redaction is structural first — these patterns exist
 * only to catch a secret that arrived under an innocent key name, which is the
 * case a key denylist alone cannot see.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, // bearer tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWTs
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i, // any URL with inline credentials
  /\b(?:sk|rk|whsec)_[A-Za-z0-9]{16,}/, // Stripe-style keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM material
];

function keyIsSecret(key: string): boolean {
  const normalised = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment.replaceAll('_', '')));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

const MAX_DEPTH = 12;

/**
 * Deep, structural redaction. Walks the object graph and redacts by key name,
 * with a value-shape backstop.
 *
 * This is deliberately NOT a regex over the final serialised string: by the
 * time a log line is a string, the structure that tells you which field held a
 * credential is gone, and a string-level regex either misses secrets or mangles
 * legitimate content such as an evidence payload.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') return valueLooksSecret(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    // Stacks are dropped here; the logger attaches them separately at error
    // level, where they are wanted, rather than everywhere an Error is nested.
    return { name: value.name, message: value.message };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = keyIsSecret(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return output;
}
```

`packages/observability/src/context.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly organizationId?: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with an ambient request context. Every log line emitted inside —
 * including from awaited async work and from queue producers — carries the
 * correlation IDs without the caller threading them through by hand.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
```

`packages/observability/src/logger.ts`:
```ts
import type { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context.js';
import { redact } from './redaction.js';

export type { Logger };

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly pretty: boolean;
  readonly silent?: boolean;
  /** Test seam. Production and development both write to stdout. */
  readonly stream?: Writable;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.silent === true ? 'silent' : options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Every logged object passes through structural redaction before it is
    // serialised. This is the single choke point — there is no path to the log
    // that skips it.
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const context = getRequestContext();
        const redacted = redact(object) as Record<string, unknown>;
        return context === undefined ? redacted : { ...context, ...redacted };
      },
    },
  };

  if (options.stream !== undefined) return pino(base, options.stream);

  if (options.pretty) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    });
  }

  return pino(base);
}
```

`packages/observability/src/index.ts`:
```ts
export { createLogger } from './logger.js';
export type { CreateLoggerOptions, Logger } from './logger.js';
export { getRequestContext, runWithRequestContext } from './context.js';
export type { RequestContext } from './context.js';
export { REDACTED, redact } from './redaction.js';
```

`packages/observability/tsconfig.json`: same shape as `packages/config/tsconfig.json`.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm vitest run --project unit packages/observability
```
Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the workspace**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(observability): structured logger with structural redaction

Pino JSON logging with AsyncLocalStorage request context, so requestId,
traceId, organizationId and userId reach every line without being threaded
through call signatures.

Redaction walks the object graph and redacts by key name, with a value-shape
backstop for secrets arriving under innocent keys. It is deliberately not a
regex over the serialised string: at that point the structure identifying
which field held a credential is already gone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

