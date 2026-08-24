### Task 2: `packages/config` — validated environment

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/env.ts`, `packages/config/src/load-env.ts`, `packages/config/src/index.ts`
- Create: `packages/config/tsconfig/base.json`, `packages/config/tsconfig/library.json`, `packages/config/tsconfig/nextjs.json`, `packages/config/tsconfig/nest.json`
- Test: `packages/config/src/env.spec.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1
- Produces:
  - `sharedEnvSchema`, `apiEnvSchema`, `webEnvSchema` — Zod object schemas
  - `loadEnv<T extends z.ZodTypeAny>(schema: T, source?: Record<string, string | undefined>): z.infer<T>` — throws `EnvValidationError` naming every bad variable
  - `class EnvValidationError extends Error` with `.variables: string[]`
  - Type exports `SharedEnv`, `ApiEnv`, `WebEnv`

- [ ] **Step 1: Write the failing test**

`packages/config/src/env.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, loadEnv } from './load-env.js';
import { apiEnvSchema, sharedEnvSchema } from './env.js';

const validShared = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  LOG_LEVEL: 'debug',
};

const validApi = {
  ...validShared,
  API_PORT: '3001',
  API_BASE_URL: 'http://localhost:3001',
  WEB_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/sentinel?schema=public',
  DIRECT_DATABASE_URL: 'postgresql://o:p@localhost:5432/sentinel?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: 'k',
  STORAGE_SECRET_ACCESS_KEY: 's',
  STORAGE_FORCE_PATH_STYLE: 'true',
  STORAGE_BUCKET_EVIDENCE: 'evidence',
  STORAGE_BUCKET_REPORTS: 'reports',
  STORAGE_BUCKET_UPLOADS: 'uploads',
  STORAGE_BUCKET_EXPORTS: 'exports',
  MAIL_HOST: 'localhost',
  MAIL_PORT: '1025',
  MAIL_FROM: 'Sentinel <no-reply@sentinel.local>',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv(apiEnvSchema, validApi);
    expect(env.API_PORT).toBe(3001);
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('names every missing variable in the error', () => {
    const { DATABASE_URL, REDIS_URL, ...incomplete } = validApi;
    expect(() => loadEnv(apiEnvSchema, incomplete)).toThrow(EnvValidationError);
    try {
      loadEnv(apiEnvSchema, incomplete);
    } catch (error) {
      const err = error as EnvValidationError;
      expect(err.variables).toContain('DATABASE_URL');
      expect(err.variables).toContain('REDIS_URL');
      expect(err.message).toContain('DATABASE_URL');
    }
  });

  it('rejects a malformed URL and names the variable', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApi, API_BASE_URL: 'not-a-url' })).toThrow(
      /API_BASE_URL/,
    );
  });

  it('rejects an APP_ENV outside the allowed set', () => {
    expect(() => loadEnv(sharedEnvSchema, { ...validShared, APP_ENV: 'prod' })).toThrow(/APP_ENV/);
  });

  it('distinguishes APP_ENV from NODE_ENV', () => {
    const env = loadEnv(sharedEnvSchema, {
      ...validShared,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.APP_ENV).toBe('staging');
  });

  it('never includes a variable value in the error message', () => {
    try {
      loadEnv(apiEnvSchema, { ...validApi, DATABASE_URL: 'postgresql://user:hunter2@bad' });
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm vitest run --project unit packages/config
```
Expected: FAIL — `Cannot find module './load-env.js'`.

- [ ] **Step 3: Write the implementation**

`packages/config/package.json`:
```json
{
  "name": "@sentinel/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./tsconfig/*": "./tsconfig/*"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": { "zod": "^3.24.0" },
  "devDependencies": { "typescript": "^5.7.0" }
}
```

`packages/config/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`packages/config/src/env.ts`:
```ts
import { z } from 'zod';

/** Coerces the string "true"/"false" that every env var actually is into a boolean. */
const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

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
});

export const webEnvSchema = sharedEnvSchema.extend({
  WEB_PORT: port,
  WEB_BASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
```

`packages/config/src/load-env.ts`:
```ts
import type { z } from 'zod';

/**
 * Thrown at boot when configuration is missing or malformed.
 *
 * The message names the offending variables and NEVER their values — an env
 * validation error is one of the easiest places to accidentally log a
 * connection string containing a password.
 */
export class EnvValidationError extends Error {
  readonly variables: string[];

  constructor(variables: string[], detail: string) {
    super(`Invalid environment configuration.\n${detail}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/**
 * Parses and validates configuration. Call once, at boot. A service must never
 * run half-configured and fail confusingly later.
 */
export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data as z.infer<TSchema>;

  const issues = result.error.issues;
  const variables = [...new Set(issues.map((issue) => String(issue.path[0] ?? '(root)')))].sort();
  // Report the variable name and the rule it broke — never the value it held.
  const detail = issues
    .map((issue) => `  ${String(issue.path[0] ?? '(root)')}: ${issue.message}`)
    .join('\n');

  throw new EnvValidationError(variables, detail);
}
```

`packages/config/src/index.ts`:
```ts
export { apiEnvSchema, sharedEnvSchema, webEnvSchema } from './env.js';
export type { ApiEnv, SharedEnv, WebEnv } from './env.js';
export { EnvValidationError, loadEnv } from './load-env.js';
```

`packages/config/tsconfig/library.json` (the preset other packages extend):
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"]
}
```

Create `tsconfig/base.json` as a copy of the root `tsconfig.base.json` compilerOptions, `tsconfig/nextjs.json` adding `"jsx": "preserve"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"module": "esnext"`, `"moduleResolution": "bundler"`, `"noEmit": true`, and `tsconfig/nest.json` adding `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`.

- [ ] **Step 4: Run the test and verify it passes**

```bash
pnpm vitest run --project unit packages/config
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the whole workspace still passes**

```bash
pnpm lint && pnpm typecheck && pnpm build
```
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(config): Zod-validated environment with boot-time failure

packages/config is the only module permitted to read process.env, enforced
by an ESLint rule. loadEnv() throws naming every offending variable and
never its value, so a malformed connection string cannot leak a password
through a startup error.

APP_ENV is modelled separately from NODE_ENV because staging and production
both run NODE_ENV=production and differ in ways that matter.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

