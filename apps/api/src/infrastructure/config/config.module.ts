import { Global, Module } from '@nestjs/common';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { CSP_ENFORCE, ENV, LOGGER } from '../tokens.js';

/**
 * Configuration and the logger, the two things every other provider needs.
 *
 * Global because threading an imports array for these through fifteen future
 * modules produces no isolation benefit and a great deal of noise. Nothing else
 * in this codebase is global.
 *
 * `loadEnv` reads `process.env` — the one permitted place, via
 * `packages/config` — and throws naming the offending variables. Because this
 * factory runs during module initialisation, a misconfigured service crashes at
 * boot rather than failing confusingly on its first request.
 * operations/environments.md §3.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): ApiEnv => loadEnv(apiEnvSchema) },
    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: ApiEnv): Logger =>
        createLogger({
          service: 'api',
          level: env.LOG_LEVEL,
          // Pretty printing runs through a worker-thread transport. Development
          // only: staging and production ship JSON, and the test environment is
          // silent unless a test asks for a stream. environments.md §1.
          pretty: env.APP_ENV === 'development',
          silent: env.APP_ENV === 'test',
        }),
    },
    {
      provide: CSP_ENFORCE,
      inject: [ENV],
      // environments.md §4: report-only while iterating in development,
      // enforcing in test, staging and production. Test enforces deliberately —
      // a policy that is only ever report-only where it is asserted is a policy
      // no test has actually seen block anything.
      useFactory: (env: ApiEnv): boolean => env.APP_ENV !== 'development',
    },
  ],
  exports: [ENV, LOGGER, CSP_ENFORCE],
})
export class ConfigModule {}
