import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@sentinel/observability';
import type { ApiEnv } from '@sentinel/config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { CorsMiddleware } from './common/middleware/cors.middleware.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware.js';
import { NestLoggerBridge } from './infrastructure/config/nest-logger.js';
import { CSP_ENFORCE, ENV, LOGGER } from './infrastructure/tokens.js';

/** What `app.use()` accepts: a bare Express handler. */
export type MiddlewareHandler = (request: Request, response: Response, next: NextFunction) => void;

/**
 * The first rows of architecture/backend.md §3, in order.
 *
 * The request ID is established before anything else so that every later stage
 * — including a failure inside the security-headers middleware itself — has
 * something to correlate by. Security headers come next so they are present on
 * a response even when a later stage throws.
 *
 * **CORS is third, and third is deliberate.** It terminates a preflight itself,
 * and a preflight response that skipped the two stages above would be the one
 * response in the application with no request ID and no security headers. It is
 * middleware rather than a guard for the same reason the two above it are: a
 * preflight carries no credentials and identifies no user, so it must not reach
 * the rate limiter or the authentication guard. ADR-0017.
 *
 * These are built as instances rather than registered through
 * `MiddlewareConsumer`, because a consumer registration is resolved relative to
 * the global prefix and therefore covers only `/api/<seg>/**` — see the note in
 * `app.module.ts`. `SecurityHeadersMiddleware`'s one dependency is read out of
 * the DI container by its token, the same way the logger already is below, so
 * `CSP_ENFORCE` stays the single place `APP_ENV` is turned into a policy mode.
 */
function crossCuttingMiddleware(app: NestExpressApplication): MiddlewareHandler[] {
  const requestId = new RequestIdMiddleware();
  const securityHeaders = new SecurityHeadersMiddleware(app.get<boolean>(CSP_ENFORCE));
  // The one allowed origin, read once at boot. `WEB_BASE_URL` is already
  // validated for scheme by `packages/config` (Task 5's ruling 48), so the
  // comparison below is against a value that has been through Zod.
  const cors = new CorsMiddleware(app.get<ApiEnv>(ENV).WEB_BASE_URL);
  return [
    (request, response, next) => {
      requestId.use(request, response, next);
    },
    (request, response, next) => {
      securityHeaders.use(request, response, next);
    },
    (request, response, next) => {
      cors.use(request, response, next);
    },
  ];
}

/**
 * Where every route in this application lives.
 *
 * Separated from `configureApp` because `configureApp` also needs the DI
 * container (it reads the logger and the CSP mode out of it), while routing is
 * pure configuration. A test that only cares about paths — the route-inventory
 * and access-assertion specs — can therefore apply the *real* prefix and
 * versioning to a two-controller application without standing up the whole
 * graph, instead of hard-coding a second copy of these values that would
 * quietly stop matching production.
 */
export function applyRouting(app: NestExpressApplication): void {
  app.setGlobalPrefix('api', {
    // Health probes are deliberately outside `/api/v1`: monitoring.md §5 and
    // backend.md §8 both write the unprefixed paths, and a probe URL that moves
    // when the API version moves breaks a deployment on the day it changes.
    //
    // `{*splat}` is path-to-regexp v8 syntax. Measured on this stack (Nest 11.2
    // / Express 5.2 / path-to-regexp 8.4), the Express 4 form `health/(.*)`
    // also works here — Nest evaluates prefix exclusions with its own matcher
    // rather than through Express's router, so v8's stricter syntax does not
    // reach it. The v8 form is used anyway. A bare `health` does NOT work: it
    // excludes only the exact path, and /health/live goes back under the
    // prefix. app.integration.spec.ts asserts both directions.
    exclude: [{ path: 'health/{*splat}', method: RequestMethod.ALL }],
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

/**
 * Applies everything that is a property of the HTTP surface rather than of a
 * module, so the integration test can build the same application the process
 * does and assert against it. A bootstrap that only exists inside `bootstrap()`
 * is a bootstrap no test has ever seen.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // First, before anything else this function does and — because `configureApp`
  // runs before `app.init()` — before Nest registers its body parser. That
  // ordering is the point: a malformed request body is rejected by the parser
  // without ever reaching a route, and a response that skipped this chain is a
  // response with no security headers and no request ID.
  // transport-and-headers.md §2 applies to *every* response, not to the routed
  // ones. `app-setup.spec.ts` asserts the order; `app.integration.spec.ts`
  // asserts the coverage, including off-prefix paths and the parser failure.
  for (const middleware of crossCuttingMiddleware(app)) {
    app.use(middleware);
  }

  // Express advertises itself by default. Removed at the app level as well as
  // per-response, so it is gone even on a response that never reaches the
  // middleware chain. transport-and-headers.md §2.
  app.disable('x-powered-by');
  // `Cache-Control: no-store` and an `ETag` are a contradiction: the API tells
  // the client never to store the response, then hands it a revalidation token
  // for the copy it was told not to keep. Express computes the tag by hashing
  // every response body, which for this service means hashing tenant data on
  // every request for no benefit. transport-and-headers.md §2.
  app.set('etag', false);

  applyRouting(app);

  const logger = app.get<Logger>(LOGGER);
  // Nest's own bootstrap and ExceptionsHandler output is human-formatted, which
  // would make this process emit two log formats and would put an unredacted
  // stack on stdout. monitoring.md §2.
  app.useLogger(new NestLoggerBridge(logger));
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalInterceptors(new LoggingInterceptor(logger));
  app.enableShutdownHooks();

  return app;
}
