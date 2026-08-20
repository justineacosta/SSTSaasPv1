import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from '@sentinel/observability';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { NestLoggerBridge } from './infrastructure/config/nest-logger.js';
import { LOGGER } from './infrastructure/tokens.js';

/**
 * Applies everything that is a property of the HTTP surface rather than of a
 * module, so the integration test can build the same application the process
 * does and assert against it. A bootstrap that only exists inside `bootstrap()`
 * is a bootstrap no test has ever seen.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
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

  app.setGlobalPrefix('api', {
    // Health probes are deliberately outside `/api/v1`: monitoring.md §5 and
    // backend.md §8 both write the unprefixed paths, and a probe URL that moves
    // when the API version moves breaks a deployment on the day it changes.
    //
    // `{*splat}` is path-to-regexp v8 syntax, matching the `*splat` used for
    // middleware in app.module.ts. Measured on this stack (Nest 11.2 / Express
    // 5.2 / path-to-regexp 8.4), the Express 4 form `health/(.*)` also works
    // here — Nest evaluates prefix exclusions with its own matcher rather than
    // through Express's router, so v8's stricter syntax does not reach it. The
    // v8 form is used anyway so both wildcard sites read the same way. A bare
    // `health` does NOT work: it excludes only the exact path, and
    // /health/live goes back under the prefix. app.integration.spec.ts asserts
    // both directions.
    exclude: [{ path: 'health/{*splat}', method: RequestMethod.ALL }],
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

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
