import { loadEnv, webEnvSchema, type WebEnv } from '@sentinel/config';

/**
 * The web app's configuration, parsed once at module load.
 *
 * `packages/config` is the only place in this workspace permitted to read
 * `process.env` (enforced by the `no-restricted-properties` rule in
 * eslint.config.js), so this module is the single door between that package
 * and everything in `apps/web`. `loadEnv` throws an `EnvValidationError`
 * naming the offending variables — and never their values — so a
 * misconfigured deployment fails loudly on the first module that touches
 * config rather than confusingly on some later request.
 *
 * There is no `apps/web/.env`: `package.json`'s dev/build/start scripts run
 * through `dotenv -e ../../.env`, the same repository-root file every other
 * package uses, so there is one place to change a port.
 */
export const env: WebEnv = loadEnv(webEnvSchema);

/**
 * Whether the Content Security Policy is sent as `Content-Security-Policy`
 * (enforcing) or `Content-Security-Policy-Report-Only`.
 *
 * `operations/environments.md` §4: report-only while iterating in development,
 * enforcing in test, staging and production. Identical rule and identical
 * derivation to the API's `CSP_ENFORCE` provider
 * (`apps/api/src/infrastructure/config/config.module.ts`), and derived exactly
 * once here so "enforcing everywhere except local" cannot drift per call site.
 *
 * Development is the one environment where Next's own dev tooling needs
 * `'unsafe-eval'` for hot reload. Rather than punch that hole in the policy,
 * development gets the report instead of the block.
 */
export const enforceCsp: boolean = env.APP_ENV !== 'development';
