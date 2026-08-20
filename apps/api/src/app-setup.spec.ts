import { describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { configureApp, type MiddlewareHandler } from './app-setup.js';
import { CSP_ENFORCE, LOGGER } from './infrastructure/tokens.js';
import { REQUEST_ID_HEADER } from './common/middleware/request-id.middleware.js';

/**
 * The narrowest stand-in for a Nest application that `configureApp` touches,
 * recording the middleware it registers in the order it registers it.
 *
 * A stub rather than a real application on purpose: this asserts the *ordering*
 * decision, which is a property of `configureApp` itself. Coverage — that the
 * chain actually reaches every path, including off-prefix ones and a body-parse
 * failure — is asserted against a live application in `app.integration.spec.ts`.
 */
function recordingApp(): { app: NestExpressApplication; handlers: MiddlewareHandler[] } {
  const handlers: MiddlewareHandler[] = [];
  const noop = (): void => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  const app = {
    use: (handler: MiddlewareHandler) => {
      handlers.push(handler);
    },
    get: (token: unknown) => (token === LOGGER ? logger : token === CSP_ENFORCE ? true : undefined),
    disable: noop,
    set: noop,
    setGlobalPrefix: noop,
    enableVersioning: noop,
    useLogger: noop,
    useGlobalFilters: noop,
    useGlobalInterceptors: noop,
    enableShutdownHooks: noop,
  } as unknown as NestExpressApplication;
  return { app, handlers };
}

interface HeaderWrite {
  readonly name: string;
  /** The request ID as it stood at the moment this header was written. */
  readonly requestIdAtWrite: unknown;
}

/** Runs the recorded chain the way Express would: each handler calls the next. */
function runChain(handlers: readonly MiddlewareHandler[]): {
  writes: HeaderWrite[];
  reachedEnd: boolean;
} {
  const request = { headers: {} } as Request;
  const writes: HeaderWrite[] = [];
  const response = {
    locals: {},
    setHeader: (name: string) => {
      writes.push({ name: name.toLowerCase(), requestIdAtWrite: request.id });
    },
    removeHeader: () => {},
  } as unknown as Response;

  let reachedEnd = false;
  const step = (index: number): void => {
    const handler = handlers[index];
    if (handler === undefined) {
      reachedEnd = true;
      return;
    }
    handler(request, response, (() => {
      step(index + 1);
    }) as NextFunction);
  };
  step(0);
  return { writes, reachedEnd };
}

describe('configureApp middleware pipeline', () => {
  it('registers exactly the two cross-cutting stages, unfiltered by path', () => {
    const { app, handlers } = recordingApp();
    configureApp(app);
    // `app.use(handler)` with no path mounts on every path and every method.
    // A path argument here is how a security header quietly stops covering a
    // route added later — which is exactly what `forRoutes({ path: '*splat' })`
    // did, because Nest resolves it under the global prefix.
    expect(handlers).toHaveLength(2);
    for (const handler of handlers) expect(handler).toHaveLength(3);
  });

  // architecture/backend.md §3: "Order matters and is asserted by a test." This
  // is that test for the two stages that exist, and it asserts the order on the
  // path production actually takes. Each guard stage added later extends this,
  // so a stage inserted in the wrong place cannot land quietly.
  it('establishes the request ID before the security headers are written', () => {
    const { app, handlers } = recordingApp();
    configureApp(app);
    const { writes, reachedEnd } = runChain(handlers);

    expect(reachedEnd).toBe(true);
    // Every header the security middleware writes — and the echo of the request
    // ID itself — must be written with a request ID already in hand, so that a
    // failure inside a later stage, including inside the security-headers
    // middleware, still correlates to a log line.
    expect(writes.length).toBeGreaterThan(1);
    const writtenBeforeAnIdExisted = writes
      .filter((write) => typeof write.requestIdAtWrite !== 'string')
      .map((write) => write.name);
    expect(writtenBeforeAnIdExisted).toEqual([]);
    expect(writes[0]?.requestIdAtWrite).toMatch(/^req_/);
    const names = writes.map((write) => write.name);
    expect(names[0]).toBe(REQUEST_ID_HEADER);
    expect(names).toContain('x-content-type-options');
    expect(names).toContain('content-security-policy');
  });
});
