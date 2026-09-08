import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { e2eEnvSchema, loadEnv, webEnvSchema } from '@sentinel/config';

/**
 * Runs `next dev` / `next start` bound to `WEB_PORT`, or to `E2E_PORT` when
 * passed `--e2e-port`.
 *
 * This exists because the obvious thing does not work. Writing
 * `next start -p $WEB_PORT` straight into a package.json script relies on the
 * script runner expanding a shell variable, and pnpm on Windows does not:
 * measured, `pnpm run` handed the literal five characters `$WEB_PORT` through
 * to the command. That failure is silent — Next falls back to its default
 * 3000 and everything looks fine — and it would have worked on Linux CI while
 * being broken on the machine this repository is developed on, which is the
 * worst shape a configuration bug can take.
 *
 * So the port is resolved in Node instead, through `@sentinel/config` like
 * every other setting. `WEB_PORT` is therefore load-bearing rather than
 * decorative: change it and the server moves.
 *
 * `loadEnv` is called here rather than importing `../src/env.ts`, because this
 * file runs under Node's TypeScript type-stripping, which does no extension
 * resolution — a relative import would have to be spelled `../src/env.ts`, and
 * tsc rejects a `.ts` specifier unless the whole project opts into
 * `allowImportingTsExtensions`. One duplicated `loadEnv` call in a launcher is
 * a smaller price than a project-wide compiler flag.
 *
 * Next is spawned as `node <next-cli-entry>` rather than through the `next`
 * bin shim, because the shim is `next.CMD` on Windows and `next` elsewhere and
 * resolving that difference means `shell: true`, which then has to worry about
 * quoting. Resolving the CLI's JS entry sidesteps both.
 *
 * `--e2e-port` is this launcher's own flag, not one of Next's, and it is an
 * explicit opt-in rather than anything inferred from `APP_ENV`: only
 * `start:e2e` passes it. It selects `E2E_PORT`, which exists so the Playwright
 * suite never shares a port with a developer's `pnpm dev` — see
 * `playwright.config.ts`. It is stripped before the remaining arguments are
 * forwarded to Next, which would reject an unknown flag. The port still
 * arrives the same way it always did, through `@sentinel/config` in Node, so
 * the property this file exists to protect is untouched: no shell-variable
 * expansion in package.json.
 *
 * **It also retargets `API_BASE_URL` at `E2E_API_PORT`**, because the suite
 * runs its own API (`apps/api/scripts/start-e2e.ts` says why) and the web
 * server has to be told where it is. Overridden here rather than as a
 * `dotenv -v` in package.json so that the port is written down once, in `.env`,
 * instead of a second literal drifting out of step with the first.
 *
 * This works at all only because of ADR-0024: the API origin is a server-side
 * runtime read handed to the provider tree as a prop, never a `NEXT_PUBLIC_`
 * value inlined into the bundle at build time. A baked-in origin would need a
 * rebuild per target, and `playwright.config.ts` would be building the app
 * twice.
 */
const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  throw new Error(`Expected "dev" or "start", received ${JSON.stringify(command)}.`);
}

// Everything after the subcommand is forwarded to Next verbatim, minus our own
// flag. Note these land *after* `--port` below, so a caller passing `--port`
// here would silently win; nothing in this repository does.
const forwarded = process.argv.slice(3).filter((argument) => argument !== '--e2e-port');
const useE2ePort = forwarded.length !== process.argv.length - 3;

// Two schemas rather than one, so that `dev`, `build` and `start` never
// require a variable that exists only for Playwright: `E2E_PORT` is demanded
// exactly when `--e2e-port` asks for it, and is invisible otherwise.
const e2eEnv = useE2ePort ? loadEnv(e2eEnvSchema) : null;
const port = e2eEnv !== null ? e2eEnv.E2E_PORT : loadEnv(webEnvSchema).WEB_PORT;

const nextCli = createRequire(import.meta.url).resolve('next/dist/bin/next');

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
if (e2eEnv !== null) childEnv.API_BASE_URL = `http://localhost:${String(e2eEnv.E2E_API_PORT)}`;

const child = spawn(process.execPath, [nextCli, command, '--port', String(port), ...forwarded], {
  stdio: 'inherit',
  env: childEnv,
});

// Forward the child's fate rather than swallowing it: a `next build` that
// fails must fail the turbo task, and Ctrl-C on `next dev` must stop this
// process too.
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
