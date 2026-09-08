import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { e2eEnvSchema, loadEnv } from '@sentinel/config';

/**
 * `pnpm start:e2e` in `apps/api` — the API the Playwright journey suite drives.
 *
 * # Why the suite cannot drive the ordinary API
 *
 * `WEB_BASE_URL` is read **once at boot** and used for two different things,
 * and both of them are wrong for the E2E suite if it names the developer's
 * server:
 *
 * 1. It is the single allowed CORS origin (`app-setup.ts` hands it to
 *    `CorsMiddleware`, and `CrossSiteGuard` compares against the same value).
 *    An API booted for `http://localhost:3000` answers the browser on
 *    `E2E_PORT` with a CORS refusal, and every authenticated step of the
 *    journey fails at the network layer for a reason that has nothing to do
 *    with the behaviour under test.
 * 2. It is the base of every link the mailer puts in an email
 *    (`modules/auth/emails/links.ts`). The journey's whole point is that it
 *    reads the verification and invitation links out of Mailpit and follows
 *    them; links pointing at a server the suite never started are links it
 *    cannot follow.
 *
 * So the harness boots its own API with `WEB_BASE_URL` pointing at `E2E_PORT`.
 * On `E2E_API_PORT` rather than `API_PORT`, for the reason `E2E_PORT` exists at
 * all: a developer's `pnpm dev:api` must never be what the suite tests, and a
 * port collision is the mechanism by which that happens. Playwright's
 * `reuseExistingServer: false` refuses to adopt a listener it did not start,
 * but a *bound* port would still make the suite's own server fail to start —
 * separate ports mean the two can run side by side.
 *
 * # What it does not override
 *
 * `DATABASE_URL` and the Mailpit settings are inherited unchanged. The journey
 * runs against the same local Postgres and the same Mailpit as everything else,
 * and registers a uniquely-addressed user per run rather than resetting
 * anything — `prisma migrate reset` cannot be run by an agent at all (Task 1's
 * ruling 3), and a suite that wiped the developer's database to test itself
 * would be a worse tool than one that leaves a few rows behind.
 *
 * `APP_ENV=test` matches `apps/web`'s `start:e2e`, so the CSP is enforcing on
 * both halves rather than report-only on one of them.
 *
 * The `dist` build is the caller's job — `playwright.config.ts` runs the build
 * ahead of this, the same way it does for the web server. Nest resolves its
 * providers from `emitDecoratorMetadata`, which Node's type-stripping does not
 * emit, so there is no running this from TypeScript directly (see
 * `scripts/dev.ts`).
 */
const { E2E_PORT, E2E_API_PORT } = loadEnv(e2eEnvSchema);

/*
 * **The one `process.env` read outside `packages/config`, and it is a forward
 * rather than a read.** The rule exists so that configuration enters the
 * application through `@sentinel/config` and nowhere else, which is exactly
 * what happens above: `API_BASE_URL`'s value is derived from `E2E_API_PORT`,
 * which `loadEnv` produced. What is happening here is passing the *parent's*
 * environment on to a child process while overriding that one key — no setting
 * is being sourced from `process.env`, and dropping the spread would start the
 * server with no DATABASE_URL, no PATH and no home directory.
 */
/* eslint-disable-next-line no-restricted-properties -- see the comment above. */
const childEnv = { ...process.env };
childEnv.APP_ENV = 'test';
// APP_ENV=test is set for the CSP, and it silences the logger as a side effect
// (`config.module.ts`). Undo exactly that side effect: this is a server whose
// 500s somebody has to be able to read.
childEnv.LOG_SILENT = 'false';
childEnv.API_PORT = String(E2E_API_PORT);
childEnv.API_BASE_URL = `http://localhost:${String(E2E_API_PORT)}`;
childEnv.WEB_BASE_URL = `http://localhost:${String(E2E_PORT)}`;

/**
 * THE API'S OUTPUT GOES TO A FILE AS WELL AS TO THE TERMINAL, AND THE FILE IS
 * THE POINT.
 *
 * Playwright relays a `webServer`'s output only while it is starting; once the
 * readiness URL answers, the process keeps logging and nobody is listening. So
 * an API that boots cleanly and then answers 500 to a request is invisible —
 * which is exactly what CI runs 34191547593, 34192382594, 34193150653 and
 * 34193910811 were: four failures at `POST /auth/register`, a 500 with a request
 * ID in the browser, and not one line of server log in the job output. Setting
 * `stdout: 'pipe'` on the webServer did not fix it, because the relay is not
 * where the output was being lost.
 *
 * `.github/workflows/ci.yml` prints this file when the E2E step fails, so the
 * reason for a 500 survives the run that produced it.
 */
const log = createWriteStream('e2e-api.log', { flags: 'w' });

const child = spawn(process.execPath, ['dist/main.js'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: childEnv,
});

child.stdout?.pipe(process.stdout);
child.stdout?.pipe(log);
child.stderr?.pipe(process.stderr);
child.stderr?.pipe(log);

// Forward the child's fate rather than swallowing it, so Playwright sees a
// server that failed to boot as a failure instead of waiting out its timeout.
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
