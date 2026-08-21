import { loadEnv, webEnvSchema } from '@sentinel/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * The port the app is actually served on, from the one place that owns it.
 * `pnpm test:e2e` runs this config under `dotenv -e ../../.env`, so the same
 * `WEB_PORT` the launcher binds (`scripts/next-on-web-port.ts`) is the one
 * these tests navigate to. Hardcoding 3000 here is what let `WEB_PORT` be
 * decorative in the first place.
 */
const { WEB_PORT } = loadEnv(webEnvSchema);
const baseURL = `http://localhost:${String(WEB_PORT)}`;

/**
 * Playwright runs against a **production build** (`next build` then
 * `next start`), not `next dev`.
 *
 * The reason is specific to what the smoke spec asserts. `next dev` injects
 * hot-reload machinery and React's development-only warnings, so "no console
 * errors" would be measuring the dev server rather than the page. The
 * production server is also the only place where the static/dynamic rendering
 * decision — and therefore whether Next's inline bootstrap scripts carry the
 * CSP nonce — is the real one.
 *
 * `pnpm test:e2e` at the repository root is what runs this.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] !== undefined ? 2 : 0,
  reporter: process.env['CI'] !== undefined ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `start:e2e` pins APP_ENV=test, which makes the CSP **enforcing** rather
    // than report-only. Deliberate, and the same call the API makes: a policy
    // that is only ever report-only wherever it is asserted is a policy no
    // test has watched block anything. operations/environments.md §4.
    command: 'pnpm build && pnpm start:e2e',
    url: baseURL,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 180_000,
  },
});
