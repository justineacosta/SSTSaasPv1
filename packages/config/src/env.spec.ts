import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './load-env.js';
import { apiEnvSchema, e2eEnvSchema, sharedEnvSchema, webEnvSchema } from './env.js';

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
    // Must actually fail validation — .startsWith('postgresql://') rejects this —
    // otherwise the catch block below never runs and the assertion is vacuous.
    const badUrl = 'mysql://user:hunter2@bad';
    expect(() => loadEnv(apiEnvSchema, { ...validApi, DATABASE_URL: badUrl })).toThrow(
      EnvValidationError,
    );
    try {
      loadEnv(apiEnvSchema, { ...validApi, DATABASE_URL: badUrl });
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('rejects a secret-looking APP_ENV value, naming the variable and the allowed options but never the value', () => {
    const secret = 'S3CR3T-SENTINEL-VALUE';
    expect(() => loadEnv(sharedEnvSchema, { ...validShared, APP_ENV: secret })).toThrow(
      EnvValidationError,
    );
    try {
      loadEnv(sharedEnvSchema, { ...validShared, APP_ENV: secret });
    } catch (error) {
      const err = error as EnvValidationError;
      expect(err.variables).toContain('APP_ENV');
      expect(err.message).toContain('APP_ENV');
      // The allowed options are safe to surface — they're schema-authored, not input.
      expect(err.message).toContain('development');
      expect(err.message).toContain('staging');
      expect(err.message).not.toContain(secret);
    }
  });

  it('never leaks a sentinel value into the error, for any field in the schema', () => {
    // A property test, not an audit of specific fields: for every key apiEnvSchema
    // knows about, swap in a value that looks exactly like a secret and confirm it
    // never surfaces — whether or not that particular field's rule happens to reject
    // it. This is what makes the guarantee scale to every schema future tasks add,
    // instead of relying on someone remembering to test the next field by hand.
    const sentinel = 'S3CR3T-SENTINEL-VALUE';
    const keys = Object.keys(apiEnvSchema.shape);
    const leaked: string[] = [];
    let throwCount = 0;

    for (const key of keys) {
      const candidate: Record<string, string> = { ...validApi, [key]: sentinel };
      try {
        loadEnv(apiEnvSchema, candidate);
      } catch (error) {
        throwCount += 1;
        const err = error as EnvValidationError;
        if (err.message.includes(sentinel) || err.variables.some((v) => v.includes(sentinel))) {
          leaked.push(key);
        }
      }
    }

    // If nothing ever throws, the assertions above never ran and this test would
    // pass vacuously — the same defect this test replaces. Fail loudly instead.
    expect(throwCount).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
  });
});

/**
 * `E2E_PORT` is a Playwright-only variable. It lives on `e2eEnvSchema` and must
 * never migrate onto `webEnvSchema`, because `apps/web/src/env.ts` parses
 * `webEnvSchema` at module load in *every* environment — so a test port on that
 * schema is a test port that a production deploy must define in order to boot.
 *
 * This is asserted here because **no gate would otherwise catch the
 * regression.** CI copies `.env.example` to `.env`, and `.env.example` defines
 * `E2E_PORT`, so the variable is always present in CI; fold it onto
 * `webEnvSchema` and every check stays green while production breaks on boot.
 * The separation is a property of the source, and this is what holds it there.
 */
describe('e2eEnvSchema / webEnvSchema separation', () => {
  const validWeb = {
    ...validShared,
    WEB_PORT: '3000',
    WEB_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: 'http://localhost:3001',
  };

  it('does not put E2E_PORT on the schema the web app boots with', () => {
    expect(Object.keys(webEnvSchema.shape)).not.toContain('E2E_PORT');
  });

  it('loads the web app config with no E2E_PORT present at all', () => {
    expect(() => loadEnv(webEnvSchema, validWeb)).not.toThrow();
  });

  it('refuses the e2e config when E2E_PORT is missing, naming it', () => {
    let error: EnvValidationError | undefined;
    try {
      loadEnv(e2eEnvSchema, validWeb);
    } catch (caught) {
      error = caught as EnvValidationError;
    }

    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error?.variables).toContain('E2E_PORT');
  });

  it('accepts the e2e config when E2E_PORT is supplied', () => {
    const parsed = loadEnv(e2eEnvSchema, { ...validWeb, E2E_PORT: '3100' });
    expect(parsed.E2E_PORT).toBe(3100);
  });

  it('keeps E2E_PORT the only difference between the two schemas', () => {
    const web = new Set(Object.keys(webEnvSchema.shape));
    const e2e = Object.keys(e2eEnvSchema.shape);
    expect(e2e.filter((key) => !web.has(key))).toEqual(['E2E_PORT']);
  });
});
