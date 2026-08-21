import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnv, webEnvSchema } from '@sentinel/config';

/**
 * Runs `next dev` / `next start` bound to `WEB_PORT`.
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
 */
const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  throw new Error(`Expected "dev" or "start", received ${JSON.stringify(command)}.`);
}

const nextCli = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(
  process.execPath,
  [nextCli, command, '--port', String(loadEnv(webEnvSchema).WEB_PORT), ...process.argv.slice(3)],
  { stdio: 'inherit' },
);

// Forward the child's fate rather than swallowing it: a `next build` that
// fails must fail the turbo task, and Ctrl-C on `next dev` must stop this
// process too.
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
