import { e2eEnvSchema, loadEnv } from '@sentinel/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * The port this suite's server is served on, from the one place that owns it.
 * `pnpm test:e2e` runs this config under `dotenv -e ../../.env`, so the same
 * `E2E_PORT` the launcher binds (`scripts/next-on-web-port.ts --e2e-port`, via
 * `start:e2e`) is the one these tests navigate to. Hardcoding 3000 here is what
 * let `WEB_PORT` be decorative in the first place.
 *
 * `E2E_PORT` rather than `WEB_PORT` because this suite must never be served by
 * a process it did not start. When the port was `WEB_PORT`, a `next dev` left
 * running from the morning was what the suite tested: `APP_ENV=development`,
 * report-only CSP, a different application from the one CI runs. It produced a
 * confusing red once, and the direction that costs more is the false green — a
 * stale server means the suite passes against code that no longer exists. Its
 * own port makes that collision structurally impossible rather than a thing to
 * remember, and `reuseExistingServer` is off (see `webServer` below) so nothing
 * else can be adopted either.
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
    // Never adopt a server this config did not start, locally or in CI.
    //
    // This was `process.env['CI'] === undefined` — reuse locally — and the
    // stated reason was that consecutive local runs should not pay for a
    // rebuild. **That reason was false, and measuring it is what settled it.**
    // Playwright tears down the server it spawns, so back-to-back
    // `pnpm test:e2e` runs each rebuilt anyway: both printed `next build`,
    // nothing was left listening on E2E_PORT afterwards, and the wall clock was
    // 9.146s then 9.179s. The option bought nothing it claimed to buy.
    //
    // What it still bought was the failure mode: the one server it could adopt
    // is a `pnpm start:e2e` someone left running, which serves the build from
    // whenever they started it. That is the stale-code false green the smoke
    // spec admits it cannot detect — a suite passing against code that no
    // longer exists. Paying nothing to remove it is an easy trade.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
