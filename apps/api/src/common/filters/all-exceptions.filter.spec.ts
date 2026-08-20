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
