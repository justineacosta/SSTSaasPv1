import { createLogger, type Logger } from '@sentinel/observability';
import { env } from './env';

/**
 * The web origin's structured logger — the redacting one from
 * `@sentinel/observability`, not `console`, which eslint.config.js bans
 * outright (`no-console: error`, coding-standards.md §6).
 *
 * Same shape as the API's logger provider
 * (`apps/api/src/infrastructure/config/config.module.ts`): pretty in
 * development, JSON everywhere else, silent under `APP_ENV=test`.
 *
 * A note for whoever hits a bundler problem here later. pino's pretty mode
 * runs through a worker-thread transport that resolves its target module by
 * filesystem path at runtime, which is a classic thing for a bundler to
 * break, so `serverExternalPackages: ['pino', 'pino-pretty']` went into
 * `next.config.ts` pre-emptively. It came back out, because it turned out not
 * to be needed: with that option commented out, a POST to `/api/csp-report`
 * against `next start` produced a correct JSON line with `pretty: false` and a
 * correct pretty-printed one with `pretty: true`. Nothing is being worked
 * around here — but if that ever changes, the fix has a name.
 */
export const logger: Logger = createLogger({
  service: 'web',
  level: env.LOG_LEVEL,
  pretty: env.APP_ENV === 'development',
  silent: env.APP_ENV === 'test',
});
