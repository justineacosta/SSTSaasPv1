### Task 9: `apps/api` — bootstrap, request ID, security headers, error envelope, health

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/common/errors/domain-error.ts`
- Create: `apps/api/src/common/filters/all-exceptions.filter.ts`
- Create: `apps/api/src/common/middleware/request-id.middleware.ts`
- Create: `apps/api/src/common/middleware/security-headers.middleware.ts`
- Create: `apps/api/src/common/interceptors/logging.interceptor.ts`
- Create: `apps/api/src/common/pipes/zod-validation.pipe.ts`
- Create: `apps/api/src/infrastructure/{config,prisma,redis,storage}/*.module.ts`
- Create: `apps/api/src/modules/health/{health.controller.ts,health.service.ts,health.module.ts}`
- Test: `apps/api/src/common/filters/all-exceptions.filter.spec.ts`, `apps/api/src/app.integration.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/config` (`apiEnvSchema`, `loadEnv`), `@sentinel/observability` (`createLogger`, `runWithRequestContext`), `@sentinel/db`, `@sentinel/storage`, `@sentinel/contracts`
- Produces:
  - `class DomainError extends Error` — `(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>)`
  - `AllExceptionsFilter implements ExceptionFilter`
  - `ZodValidationPipe` — validates a body/query/param against a contract schema, throws `DomainError(VALIDATION_ERROR, …, 400)` carrying `details.fields: FieldError[]`
  - `GET /health/live`, `GET /health/ready`, `GET /health/detailed`

> **ESM note for the implementer.** Everything in this workspace is ESM. If NestJS's DI or CLI
> fights ESM in a way that costs more than about an hour, switch **only `apps/api`** to
> CommonJS (`"type": "commonjs"`, keeping `"module": "nodenext"`). Node 26's `require(esm)`
> bridges to the ESM packages, none of which use top-level await. Record whichever way it went
> in the commit body. Do not convert the packages.

- [ ] **Step 1: Write the failing error-filter unit test**

`apps/api/src/common/filters/all-exceptions.filter.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, errorEnvelopeSchema } from '@sentinel/contracts';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { DomainError } from '../errors/domain-error.js';

function invoke(exception: unknown): { status: number; body: unknown } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: 'req_01J', url: '/api/v1/x', method: 'GET' }),
    }),
  };
  new AllExceptionsFilter().catch(exception, host as never);
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] };
}

describe('AllExceptionsFilter', () => {
  it('maps a domain error to its own code and status', () => {
    const { status, body } = invoke(
      new DomainError(ERROR_CODES.SCOPE_VIOLATION, 'Target is not permitted.', 422, {
        target: 'admin.example.com',
      }),
    );
    expect(status).toBe(422);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('SCOPE_VIOLATION');
    expect(parsed.error.details).toEqual({ target: 'admin.example.com' });
  });

  it('maps a 404 HttpException to RESOURCE_NOT_FOUND', () => {
    const { status, body } = invoke(new HttpException('nope', HttpStatus.NOT_FOUND));
    expect(status).toBe(404);
    expect(errorEnvelopeSchema.parse(body).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('maps an unknown throwable to a generic INTERNAL_ERROR', () => {
    const { status, body } = invoke(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(status).toBe(500);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    // errors.md §5: no internal hosts, no database detail, no stack.
    expect(parsed.error.message).not.toContain('ECONNREFUSED');
    expect(parsed.error.message).not.toContain('10.0.0.5');
  });

  it('always includes the request id', () => {
    expect(errorEnvelopeSchema.parse(invoke(new Error('x')).body).error.requestId).toBe('req_01J');
  });

  it('never emits a stack property', () => {
    expect(JSON.stringify(invoke(new Error('x')).body)).not.toContain('stack');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
pnpm vitest run --project unit apps/api
```
Expected: FAIL — `Cannot find module './all-exceptions.filter.js'`.

- [ ] **Step 3: Implement the error layer**

`apps/api/src/common/errors/domain-error.ts`:
```ts
import type { ErrorCode } from '@sentinel/contracts';

/**
 * The base class for every error the domain raises.
 *
 * Domain code never throws a bare Error: a bare Error carries no code, so the
 * filter can only map it to INTERNAL_ERROR, and the client learns nothing it
 * can act on. A refusal that does not say how to succeed generates a support
 * ticket. See api/errors.md §4.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
```

`apps/api/src/common/filters/all-exceptions.filter.ts`:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@sentinel/contracts';
import { DomainError } from '../errors/domain-error.js';

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
}

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ERROR_CODES.VALIDATION_ERROR,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.PERMISSION_DENIED,
  404: ERROR_CODES.RESOURCE_NOT_FOUND,
  409: ERROR_CODES.DUPLICATE_RESOURCE,
  422: ERROR_CODES.INVALID_STATE_TRANSITION,
  429: ERROR_CODES.RATE_LIMITED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * One envelope for every error, without exception. api/errors.md §1.
 *
 * The final branch is the one that matters: an unrecognised throwable returns a
 * generic message and the request ID and nothing else. Stack traces, database
 * errors, constraint names, internal hosts, and service names never reach a
 * client — they go to the server log, which the request ID correlates to.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const requestId = http.getRequest<{ id?: string }>().id ?? 'req_unknown';
    const response = http.getResponse<ResponseLike>();

    if (exception instanceof DomainError) {
      const envelope: ErrorEnvelope = {
        error: {
          code: exception.code,
          message: exception.message,
          requestId,
          ...(exception.details === undefined ? {} : { details: exception.details }),
        },
      };
      response.status(exception.status).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const envelope: ErrorEnvelope = {
        error: {
          code: STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL_ERROR,
          message: exception.message,
          requestId,
        },
      };
      response.status(status).json(envelope);
      return;
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our side. Quote the request ID if you contact support.',
        requestId,
      },
    };
    response.status(500).json(envelope);
  }
}
```

- [ ] **Step 4: Run the unit test and verify it passes**

```bash
pnpm vitest run --project unit apps/api
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement middleware, the validation pipe, health, and bootstrap**

`request-id.middleware.ts` — reads or generates `x-request-id` (using `newId('req')`), attaches
it to the request object, echoes it on the response, and wraps `next()` in
`runWithRequestContext` so every log line inside the request correlates without being threaded
through call signatures.

`security-headers.middleware.ts` — sets **exactly** the table in
`security/transport-and-headers.md` §2, generates a per-request CSP nonce, and builds the §3
policy. `Content-Security-Policy-Report-Only` in development, `Content-Security-Policy`
otherwise, per `environments.md` §4:

```ts
import { randomBytes } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  constructor(private readonly enforceCsp: boolean) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    const nonce = randomBytes(16).toString('base64');
    response.locals.cspNonce = nonce;

    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // The API serves nothing cacheable; every response may contain tenant data.
    response.setHeader('Cache-Control', 'no-store');
    response.removeHeader('X-Powered-By');

    const policy = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
      'report-uri /api/v1/csp-report',
    ].join('; ');

    response.setHeader(
      this.enforceCsp ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      policy,
    );

    next();
  }
}
```

`zod-validation.pipe.ts` — validates against a contract schema and converts Zod issues into the
`FieldError[]` shape from `errors.md` §2, with dotted/bracketed paths. It has no consumer in
Phase 1 (health takes no input); it exists so Phase 2's first endpoint inherits it rather than
inventing its own, and its unit test drives it directly with a schema.

`health.service.ts` — `checkDependencies()` runs `SELECT 1` against Postgres, `PING` against
Redis, and a `head()` on a known-absent storage key (which must return `null`, not throw). It
reports each dependency individually so an operator sees *which* one is down, and returns 503
if any failed.

`health.controller.ts`:
```ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness checks the process and NOTHING else.
   *
   * A liveness probe that checks Postgres restarts every application instance
   * simultaneously during a database blip, turning a hiccup into a full
   * outage. monitoring.md §5.
   */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  ready(): Promise<ReadinessReport> {
    return this.health.checkDependencies();
  }

  @Public()
  @Get('detailed')
  detailed(): Promise<DetailedReport> {
    return this.health.detailed();
  }
}
```

`main.ts` — `loadEnv(apiEnvSchema)` first (so misconfiguration crashes before anything binds a
port), then URI versioning with global prefix `api` and default version `1`, the global
exception filter, the logging interceptor, and `listen(env.API_PORT)`.

- [ ] **Step 6: Write the API integration test**

`apps/api/src/app.integration.spec.ts`, using `supertest` against the real Nest app and the
live compose stack. Write each of these as a real assertion:

```ts
describe('API surface', () => {
  it('GET /health/live returns 200 and touches no dependency', async () => {
    await request(server).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready reports postgres, redis and storage individually', async () => {
    const response = await request(server).get('/health/ready').expect(200);
    expect(response.body.dependencies).toMatchObject({
      postgres: 'ok',
      redis: 'ok',
      storage: 'ok',
    });
  });

  it('echoes a supplied x-request-id', async () => {
    const response = await request(server)
      .get('/health/live')
      .set('x-request-id', 'req_supplied')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('req_supplied');
  });

  it('generates a request id when none is supplied', async () => {
    const response = await request(server).get('/health/live').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('sets every header in transport-and-headers.md §2', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    expect(headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  it('sets a nonce-based CSP with no unsafe-inline and no unsafe-eval', async () => {
    const { headers } = await request(server).get('/health/live').expect(200);
    const csp =
      headers['content-security-policy'] ?? headers['content-security-policy-report-only'];
    expect(csp).toBeDefined();
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('issues a different nonce on every request', async () => {
    const cspOf = async (): Promise<string> => {
      const { headers } = await request(server).get('/health/live');
      return (headers['content-security-policy'] ??
        headers['content-security-policy-report-only']) as string;
    };
    expect(await cspOf()).not.toBe(await cspOf());
  });

  it('returns the error envelope for an unmatched route', async () => {
    const response = await request(server).get('/api/v1/does-not-exist').expect(404);
    const parsed = errorEnvelopeSchema.parse(response.body);
    expect(parsed.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(parsed.error.requestId).toMatch(/^req_/);
  });
});
```

- [ ] **Step 7: Run everything, verify, commit**

```bash
docker compose up -d
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(api): NestJS bootstrap with security headers, error envelope, and health

The cross-cutting pipeline from architecture/backend.md §3 with one module
behind it. Request IDs propagate into the logging context; security headers
match transport-and-headers.md §2 exactly; CSP is nonce-based with a fresh
nonce per request, no unsafe-inline and no unsafe-eval, report-only locally
and enforcing elsewhere.

The global filter produces the shared envelope for every error class. A 5xx
returns a generic message and the request ID and nothing else — no stack, no
database error, no internal host.

Liveness deliberately checks the process only: a liveness probe that checks
Postgres restarts every instance at once during a blip, turning a hiccup into
an outage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

