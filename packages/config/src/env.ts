import { z } from 'zod';

/** Coerces the string "true"/"false" that every env var actually is into a boolean. */
const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65_535);

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // APP_ENV is deliberately separate from NODE_ENV: staging and production both
  // run with NODE_ENV=production but differ in ways that matter — feature flag
  // defaults, log verbosity, and whether the deny list covers our own hosts.
  // See .claude/operations/environments.md §3.
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export const apiEnvSchema = sharedEnvSchema.extend({
  API_PORT: port,
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1).startsWith('postgresql://'),
  DIRECT_DATABASE_URL: z.string().min(1).startsWith('postgresql://'),

  REDIS_URL: z.string().min(1).startsWith('redis://'),

  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromString,
  STORAGE_BUCKET_EVIDENCE: z.string().min(1),
  STORAGE_BUCKET_REPORTS: z.string().min(1),
  STORAGE_BUCKET_UPLOADS: z.string().min(1),
  STORAGE_BUCKET_EXPORTS: z.string().min(1),

  MAIL_HOST: z.string().min(1),
  MAIL_PORT: port,
  MAIL_FROM: z.string().min(1),

  // Passwords ---------------------------------------------------------------
  //
  // API-only, and deliberately not on `sharedEnvSchema`. `apps/web/src/env.ts`
  // parses its schema at module load in every environment, so a variable added
  // to the shared schema becomes one every web deploy must define in order to
  // boot. The comment above `e2eEnvSchema` records the same rule for `E2E_PORT`.
  //
  // Every one of these carries a default, so nothing existing has to change to
  // keep booting. ADR-0014: the Argon2id parameters live in configuration
  // rather than in a constant precisely so an operator can raise them — after
  // tuning on production hardware, which the starting points below have not
  // been — without a code change, a build, or a deploy. `PasswordService`
  // reports `needsRehash` against them, so raised parameters take effect on
  // existing accounts at their owners' next successful login.
  //
  // security/authentication.md §2 is where m=64MiB / t=3 / p=4 comes from, and
  // it names them as a starting point only.
  PASSWORD_ARGON2_MEMORY_KIB: z.coerce.number().int().min(8).default(65_536),
  PASSWORD_ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
  PASSWORD_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(255).default(4),

  // ADR-0015. The flag defaults to **false**, so no test suite anywhere
  // depends on a third party being reachable and no environment gets the
  // outbound call by accident; an environment that wants the check turns it on
  // explicitly. The check fails open on timeout, so the timeout is a latency
  // budget for registration and password change, not just an error bound.
  PASSWORD_BREACH_CHECK_ENABLED: booleanFromString.default('false'),
  PASSWORD_BREACH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1).default(2_000),
  PASSWORD_BREACH_CHECK_RANGE_URL: z.string().url().default('https://api.pwnedpasswords.com/range'),
});

export const webEnvSchema = sharedEnvSchema.extend({
  WEB_PORT: port,
  WEB_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
});

/**
 * The web schema plus the one variable only the end-to-end harness needs.
 *
 * `E2E_PORT` is the port the Playwright suite's own server binds, deliberately
 * not `WEB_PORT`. `playwright.config.ts` keeps `reuseExistingServer` locally so
 * consecutive runs stay fast, which means it attaches to whatever is already
 * listening — and a `next dev` left on `WEB_PORT` runs `APP_ENV=development`,
 * making the suite test a different application than CI does. That happened,
 * and it produced both a confusing false failure and (worse) a false pass. A
 * separate port makes the collision structurally impossible rather than a
 * habit.
 *
 * **It is a separate schema rather than a field on `webEnvSchema` because the
 * running web app must never need it.** `apps/web/src/env.ts` parses
 * `webEnvSchema` at module load in every environment, so a test-only variable
 * added there becomes a variable every production deploy has to define in order
 * to boot — a Playwright port gating a customer-facing server. Only
 * `playwright.config.ts` and the launcher's `--e2e-port` path parse this, which
 * is precisely where a missing `E2E_PORT` should fail loudly.
 */
export const e2eEnvSchema = webEnvSchema.extend({
  E2E_PORT: port,
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type E2eEnv = z.infer<typeof e2eEnvSchema>;
