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
const { E2E_PORT, E2E_API_PORT, E2E_MAILPIT_URL } = loadEnv(e2eEnvSchema);
const baseURL = `http://localhost:${String(E2E_PORT)}`;
const apiURL = `http://localhost:${String(E2E_API_PORT)}`;

/**
 * The two origins and the mailbox the specs need, re-exported.
 *
 * **This is how configuration reaches a spec, and the indirection is not
 * decorative.** `eslint.config.js` forbids `process.env` everywhere except
 * `packages/config` and files matching `*.config.ts` — this file is the
 * second — so a spec cannot read the environment for itself. Importing these
 * from here keeps the single `loadEnv` call and gives the specs typed
 * constants, rather than re-deriving a port that `.env` already owns.
 */
export const E2E_WEB_ORIGIN = baseURL;
export const E2E_API_ORIGIN = apiURL;
export const E2E_MAILPIT_ORIGIN = E2E_MAILPIT_URL;

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
  // ONE WORKER, AND IT IS THE RATE LIMITER THAT DECIDES THIS, NOT SPEED.
  //
  // `registration` is 3 per IP per hour, and every worker in this suite shares
  // one IP — so the budget is global mutable state that parallel workers race
  // on. The journey registers two accounts and `failure-paths` four; clearing
  // the counters per test in one file while another file registers
  // concurrently is not a fix, it is a narrower race. CI proved it: run
  // 34191547593 failed both registration steps with 36 passing around them,
  // while the identical code passed locally, because local scheduling happened
  // to interleave the two files differently.
  //
  // Serialising costs about a minute of wall clock and buys determinism in the
  // one suite whose failures are most expensive to diagnose. The alternative —
  // raising the limit under APP_ENV=test — is rejected for the reason
  // `global-setup.ts` gives.
  workers: 1,
  // Clears the rate limiter before the run. `e2e/global-setup.ts` explains why
  // the suite cannot run twice in an hour without it, and why raising the
  // limits under APP_ENV=test was the wrong answer.
  globalSetup: './e2e/global-setup.ts',
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
  // TWO servers, because the journey exit criterion is an authenticated round
  // trip and there is no such thing against a web server alone. The API comes
  // first in the array only for readability — Playwright starts them
  // concurrently and waits for both `url`s, which is what we want: the web
  // server does not call the API during boot.
  //
  // **This suite requires the Docker Compose stack** (`docker compose up -d`)
  // for Postgres, Redis and Mailpit. Nothing here starts it: the containers are
  // shared with ordinary development and with `pnpm test:integration`, and a
  // Playwright config that tore them down between runs would be a worse
  // neighbour than one that documents the prerequisite. A stack that is not up
  // shows as `/health/ready` never going green, which names the missing
  // dependency in its own response body.
  webServer: [
    {
      // The suite's own API, on its own port, with WEB_BASE_URL pointed at this
      // suite's web server — `apps/api/scripts/start-e2e.ts` explains why both
      // of those are load-bearing rather than tidiness.
      command: 'pnpm --filter @sentinel/api build && pnpm --filter @sentinel/api start:e2e',
      // `/health/ready` rather than `/health/live`: live means the process is
      // listening, ready means it reached Postgres and Redis. Waiting on live
      // would start the journey against an API that cannot serve it, and the
      // first failure would be some unrelated assertion timing out rather than
      // the truth. `setGlobalPrefix` excludes the health paths, so there is no
      // `/api` segment here.
      url: `${apiURL}/health/ready`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // `start:e2e` pins APP_ENV=test, which makes the CSP **enforcing** rather
      // than report-only. Deliberate, and the same call the API makes: a policy
      // that is only ever report-only wherever it is asserted is a policy no
      // test has watched block anything. operations/environments.md §4.
      //
      // It also points API_BASE_URL at E2E_API_PORT, so the browser is told to
      // call the API this config started rather than a developer's.
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
  ],
});
