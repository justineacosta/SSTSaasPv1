import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ERROR_CODES, errorEnvelopeSchema } from '@sentinel/contracts';
import { AllExceptionsFilter, type ErrorLogger } from './all-exceptions.filter.js';
import { DomainError } from '../errors/domain-error.js';

interface LogCall {
  readonly level: 'error' | 'warn';
  readonly bindings: Record<string, unknown>;
  readonly message: string;
}

function recordingLogger(): { logger: ErrorLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    logger: {
      error: (bindings, message) =>
        calls.push({ level: 'error', bindings: bindings as Record<string, unknown>, message }),
      warn: (bindings, message) =>
        calls.push({ level: 'warn', bindings: bindings as Record<string, unknown>, message }),
    },
  };
}

function invokeWith(
  exception: unknown,
  logger?: ErrorLogger,
  request: Record<string, unknown> = { id: 'req_01J', url: '/api/v1/x', method: 'GET' },
): { status: number; body: unknown } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => request,
    }),
  };
  new AllExceptionsFilter(logger).catch(exception, host as never);
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] };
}

function invoke(exception: unknown): { status: number; body: unknown } {
  return invokeWith(exception);
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

describe('AllExceptionsFilter — what must never reach the client', () => {
  it('does not pass a 5xx HttpException message through to the client', () => {
    // `new InternalServerErrorException(err.message)` is a common way to wrap an
    // internal failure, and it would otherwise ride the HttpException branch with
    // its message intact. errors.md §5: an internal error returns a generic
    // message and the request ID, whatever class it arrived as.
    const { status, body } = invoke(
      new InternalServerErrorException(
        'Invalid prisma.finding.create(): Unique constraint failed on the fields: (Finding_organizationId_fingerprint_key)',
      ),
    );
    expect(status).toBe(500);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).not.toContain('prisma');
    expect(parsed.error.message).not.toContain('Finding_organizationId_fingerprint_key');
    expect(parsed.error.message).not.toContain('constraint');
  });

  it('does not pass a 503 HttpException message through to the client', () => {
    const { status, body } = invoke(
      new ServiceUnavailableException('redis://user:hunter2@10.0.0.7:6379 is unreachable'),
    );
    expect(status).toBe(503);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(parsed.error.message).not.toContain('10.0.0.7');
    expect(parsed.error.message).not.toContain('hunter2');
  });

  it('redacts a secret-shaped substring from a client-visible 4xx message', () => {
    const { body } = invoke(
      new BadRequestException('Webhook URL https://svc:hunter2@internal.example/hook was rejected'),
    );
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.message).not.toContain('hunter2');
    expect(parsed.error.message).toContain('was rejected');
  });

  it('redacts secret-shaped content from a domain error message and its details', () => {
    const { body } = invoke(
      new DomainError(
        ERROR_CODES.VALIDATION_ERROR,
        'Callback https://u:hunter2@example.com/cb was rejected',
        400,
        {
          callbackUrl: 'https://u:hunter2@example.com/cb',
          apiKey: 'sk_live_0123456789abcdefghij',
        },
      ),
    );
    const parsed = errorEnvelopeSchema.parse(body);
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('sk_live_0123456789abcdefghij');
    expect(parsed.error.message).toContain('was rejected');
  });

  it('emits no property of the original error other than the envelope fields', () => {
    class PrismaLikeError extends Error {
      readonly code = 'P2002';
      readonly meta = { target: ['Finding_organizationId_fingerprint_key'] };
      readonly clientVersion = '6.19.3';
    }
    const { body } = invoke(new PrismaLikeError('Unique constraint failed'));
    expect(Object.keys(body as object)).toEqual(['error']);
    expect(Object.keys((body as { error: object }).error).sort()).toEqual([
      'code',
      'message',
      'requestId',
    ]);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('P2002');
    expect(serialised).not.toContain('Finding_organizationId_fingerprint_key');
    expect(serialised).not.toContain('6.19.3');
  });

  it('keeps an authored 5xx domain error intact, because that is the readiness contract', () => {
    // The one deliberate exception to "no 5xx carries a message". /health/ready
    // returns 503 and an operator has to learn *which* dependency is down from
    // it — a generic body would make the endpoint useless for the one job
    // monitoring.md §5 gives it.
    const { status, body } = invoke(
      new DomainError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'One or more dependencies are unavailable.',
        503,
        { dependencies: { postgres: 'ok', redis: 'error', storage: 'ok' } },
      ),
    );
    expect(status).toBe(503);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(parsed.error.details).toEqual({
      dependencies: { postgres: 'ok', redis: 'error', storage: 'ok' },
    });
  });

  it('falls back to req_unknown when the request carries no id', () => {
    const { body } = invokeWith(new Error('x'), undefined, { url: '/x', method: 'GET' });
    expect(errorEnvelopeSchema.parse(body).error.requestId).toBe('req_unknown');
  });
});

describe('AllExceptionsFilter — what must reach the log', () => {
  it('logs a 5xx at error with the error, the request id, and a redacted message', () => {
    const { logger, calls } = recordingLogger();
    invokeWith(new Error('connect to redis://user:hunter2@10.0.0.7:6379 refused'), logger);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.level).toBe('error');
    expect(call.bindings.requestId).toBe('req_01J');
    expect(call.bindings.statusCode).toBe(500);
    expect(call.bindings.err).toBeInstanceOf(Error);
    // The logger's own `err` serialiser redacts the Error; the `msg` string is
    // redacted here because pino's msg-from-error fallback is preempted by
    // observability/logger.ts's logMethod hook only when a string msg is absent —
    // once this filter supplies one, this filter owns its redaction.
    expect(call.message).not.toContain('hunter2');
    expect(call.message).toContain('refused');
  });

  it('logs a 4xx at warn with the code and path but never the exception body', () => {
    const { logger, calls } = recordingLogger();
    invokeWith(new DomainError(ERROR_CODES.SCOPE_VIOLATION, 'Nope.', 422), logger);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.level).toBe('warn');
    expect(call.bindings.code).toBe('SCOPE_VIOLATION');
    expect(call.bindings.path).toBe('/api/v1/x');
    expect(call.bindings.statusCode).toBe(422);
    expect(call.bindings.err).toBeUndefined();
  });

  it('still answers the client when the logger itself throws', () => {
    const exploding: ErrorLogger = {
      error: () => {
        throw new Error('log transport down');
      },
      warn: () => {
        throw new Error('log transport down');
      },
    };
    const { status, body } = invokeWith(new Error('boom'), exploding);
    expect(status).toBe(500);
    expect(errorEnvelopeSchema.parse(body).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('AllExceptionsFilter — throwables from the http-errors library', () => {
  /**
   * The shape `body-parser` actually raises. Reproduced rather than imported so
   * the test states the contract it depends on: `status`, `statusCode`, and a
   * boolean `expose`.
   */
  class PayloadTooLargeError extends Error {
    readonly status = 413;
    readonly statusCode = 413;
    readonly expose = true;
    readonly type = 'entity.too.large';
    readonly limit = 102_400;
  }

  it('serves a body over the size limit as a 413, not a 500', () => {
    // Before this branch existed, body-parser's error fell through to the
    // catch-all and every oversized request answered 500 — a 5xx any caller
    // could drive at will, against the alert in monitoring.md §6, and telling
    // the client nothing it could act on (errors.md §4).
    const { status, body } = invoke(new PayloadTooLargeError('request entity too large'));
    expect(status).toBe(413);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.message).toBe('request entity too large');
  });

  it('gives an unmapped 4xx a client-class code, never a Server-class one', () => {
    // errors.md §3 files INTERNAL_ERROR under Server and §1 says clients branch
    // on `code`. A 413 labelled INTERNAL_ERROR tells a client to retry its own
    // bad request as a server fault.
    const parsed = errorEnvelopeSchema.parse(invoke(new PayloadTooLargeError('too large')).body);
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    [405, 'VALIDATION_ERROR'],
    [406, 'VALIDATION_ERROR'],
    [415, 'VALIDATION_ERROR'],
    [418, 'VALIDATION_ERROR'],
  ])('maps an unmapped %s HttpException to %s', (status, code) => {
    const result = invoke(new HttpException('nope', status));
    expect(result.status).toBe(status);
    expect(errorEnvelopeSchema.parse(result.body).error.code).toBe(code);
  });

  it('leaves an unmapped 5xx on INTERNAL_ERROR', () => {
    const result = invoke(new HttpException('upstream exploded', 502));
    expect(result.status).toBe(502);
    const parsed = errorEnvelopeSchema.parse(result.body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).not.toContain('upstream exploded');
  });

  it('ignores a status on a throwable that is not an http-errors object', () => {
    // The discrimination is the point. A Prisma, AWS-SDK or fetch error carrying
    // a status-shaped property must not get to choose this API's HTTP status or
    // to put its own message in front of a client.
    class DriverError extends Error {
      readonly status = 404;
      readonly statusCode = 404;
      readonly meta = { table: 'Finding' };
    }
    const { status, body } = invoke(new DriverError('relation "Finding" does not exist'));
    expect(status).toBe(500);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).not.toContain('Finding');
  });

  it('withholds the message of an http-error that says it is not safe to expose', () => {
    class UnexposedError extends Error {
      readonly status = 400;
      readonly statusCode = 400;
      readonly expose = false;
      readonly connectionString = 'postgres://sentinel:hunter2@db-primary.internal:5432';
    }
    const { status, body } = invoke(new UnexposedError('db-primary.internal rejected the request'));
    expect(status).toBe(400);
    const parsed = errorEnvelopeSchema.parse(body);
    // Three properties at once, because dropping any one of them is a
    // regression someone would plausibly introduce while tidying:
    const { code, message } = parsed.error;
    // (a) the withheld text stays withheld,
    expect(message).not.toContain('db-primary.internal');
    expect(message).not.toContain('hunter2');
    // (b) the code is client-class — errors.md §3 files INTERNAL_ERROR under
    //     Server and §1 has clients branching on `code`,
    expect(code).toBe('VALIDATION_ERROR');
    // (c) and so is the *message*. A 4xx reading "something went wrong on our
    //     side" tells the caller their own bad request was our fault, which
    //     re-introduces one layer up exactly the confusion (b) removes, and
    //     generates the support ticket errors.md §4 is written to avoid.
    expect(message).toBe(
      'The request could not be accepted. Quote the request ID if you contact support.',
    );
    expect(message).not.toContain('on our side');
  });

  it('still uses the server-side generic message for a 5xx, which is a different string', () => {
    // The two must not be collapsed back into one. This pins both halves: the
    // 5xx text is unchanged, and it is not the client-class text.
    class UnexposedServerError extends Error {
      readonly status = 502;
      readonly statusCode = 502;
      readonly expose = false;
    }
    const { status, body } = invoke(new UnexposedServerError('upstream pool exhausted'));
    expect(status).toBe(502);
    const { code, message } = errorEnvelopeSchema.parse(body).error;
    expect(code).toBe('INTERNAL_ERROR');
    expect(message).toBe(
      'Something went wrong on our side. Quote the request ID if you contact support.',
    );
    expect(message).not.toContain('upstream pool exhausted');
  });

  it('withholds the message of a 5xx http-error even when it claims to be exposable', () => {
    class ExposedServerError extends Error {
      readonly status = 500;
      readonly statusCode = 500;
      readonly expose = true;
    }
    const { status, body } = invoke(new ExposedServerError('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(status).toBe(500);
    const parsed = errorEnvelopeSchema.parse(body);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).not.toContain('10.0.0.5');
  });

  it('redacts a secret-shaped substring out of an exposable http-error message', () => {
    class BadUrlError extends Error {
      readonly status = 400;
      readonly statusCode = 400;
      readonly expose = true;
    }
    const { body } = invoke(new BadUrlError('rejected https://user:hunter2@example.com/callback'));
    expect(errorEnvelopeSchema.parse(body).error.message).not.toContain('hunter2');
  });
});
