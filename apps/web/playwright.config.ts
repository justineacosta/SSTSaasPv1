import { e2eEnvSchema, loadEnv } from '@sentinel/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * The port this suite's server is served on, from the one place that owns it.
 * `pnpm test:e2e` runs this config under `dotenv -e ../../.env`, so the same
 * `E2E_PORT` the launcher binds (`scripts/next-on-web-port.ts --e2e-port`, via
 * `start:e2e`) is the one these tests navigate to. Hardcoding 3000 here is what
 * let `WEB_PORT` be decorative in the first place.
 *
 * `E2E_PORT` rather than `WEB_PORT` because of `reuseExistingServer` below.
 * That option is kept — consecutive local runs should not pay for a rebuild —
 * but it means Playwright attaches to whatever is already listening on this
 * port. When that port was `WEB_PORT`, a `next dev` left running from the
 * morning was what the suite tested: `APP_ENV=development`, report-only CSP, a
 * different application from the one CI runs. It produced a confusing red once,
 * and the direction that costs more is the false green — a stale server means
 * the suite passes against code that no longer exists. Its own port makes the
 * collision structurally impossible rather than a thing to remember.
 */
const { E2E_PORT } = loadEnv(e2eEnvSchema);
const baseURL = `http://localhost:${String(E2E_PORT)}`;

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
  // `github` annotates the failing line in the PR diff; `html` writes
  // `playwright-report/`, which the CI job uploads on failure (Task 14). Both,
  // because the annotation is what a reviewer sees first and the report is what
  // they need once they want the trace. Locally, neither — `list` prints to the
  // terminal the developer is already looking at.
  reporter:
    process.env['CI'] !== undefined ? [['github'], ['html', { open: 'never' }]] : [['list']],
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
