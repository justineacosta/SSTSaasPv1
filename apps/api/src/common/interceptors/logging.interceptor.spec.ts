import { describe, expect, it } from 'vitest';
import { firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { LoggingInterceptor, type RequestLogger } from './logging.interceptor.js';

interface LogCall {
  readonly bindings: Record<string, unknown>;
  readonly message: string;
}

function recordingLogger(): { logger: RequestLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    logger: {
      info: (bindings, message) =>
        calls.push({ bindings: bindings as Record<string, unknown>, message }),
    },
  };
}

function contextFor(request: Record<string, unknown>, statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

const handlerOf = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('LoggingInterceptor', () => {
  it('logs one structured line per completed request', async () => {
    const { logger, calls } = recordingLogger();
    await firstValueFrom(
      new LoggingInterceptor(logger).intercept(
        contextFor({ method: 'GET', originalUrl: '/health/live', id: 'req_01J' }, 200),
        handlerOf({ status: 'ok' }),
      ),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.bindings).toMatchObject({ method: 'GET', path: '/health/live', statusCode: 200 });
    expect(typeof call.bindings.durationMs).toBe('number');
  });

  it('strips the query string from the logged path', async () => {
    // A query string carries invitation tokens, reset tokens, and API keys that
    // a caller put in the wrong place. The route is what an operator needs;
    // the arguments are not. monitoring.md §2, errors.md §6.
    const { logger, calls } = recordingLogger();
    await firstValueFrom(
      new LoggingInterceptor(logger).intercept(
        contextFor({
          method: 'GET',
          originalUrl: '/api/v1/invitations/accept?token=SUPER-SECRET-TOKEN',
          id: 'req_01J',
        }),
        handlerOf(null),
      ),
    );
    expect(calls[0]!.bindings.path).toBe('/api/v1/invitations/accept');
    expect(JSON.stringify(calls[0])).not.toContain('SUPER-SECRET-TOKEN');
  });

  it('logs neither the request body nor the request headers', async () => {
    const { logger, calls } = recordingLogger();
    await firstValueFrom(
      new LoggingInterceptor(logger).intercept(
        contextFor({
          method: 'POST',
          originalUrl: '/api/v1/auth/login',
          id: 'req_01J',
          body: { email: 'a@b.test', password: 'CORRECT-HORSE' },
          headers: { cookie: '__Host-session=SESSIONVALUE' },
        }),
        handlerOf(null),
      ),
    );
    const serialised = JSON.stringify(calls[0]);
    expect(serialised).not.toContain('CORRECT-HORSE');
    expect(serialised).not.toContain('SESSIONVALUE');
    expect(serialised).not.toContain('a@b.test');
  });

  it('logs nothing on failure and lets the error propagate to the filter', async () => {
    const { logger, calls } = recordingLogger();
    const failing = {
      handle: () => throwError(() => new Error('boom')),
    } as unknown as CallHandler;

    await expect(
      lastValueFrom(
        new LoggingInterceptor(logger).intercept(
          contextFor({ method: 'GET', originalUrl: '/x', id: 'req_01J' }),
          failing,
        ),
      ),
    ).rejects.toThrow('boom');
    // The exception filter owns the failure line, with the status code the
    // interceptor cannot yet see. Logging here too would double-count every
    // error in the error-rate metric.
    expect(calls).toHaveLength(0);
  });
});
