import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * `pnpm dev:api` — compile on change, restart on compile.
 *
 * Two processes, because the API cannot be run from TypeScript directly. Nest
 * resolves its providers from `emitDecoratorMetadata` output, and Node's
 * type-stripping only erases types — it emits no metadata — so `node --watch
 * src/main.ts` starts an application whose dependency injection cannot resolve
 * anything. `apps/api/openapi:generate` compiles first for the same reason.
 * So: `tsc --watch` writes `dist`, and `node --watch dist/main.js` restarts
 * whenever it changes.
 *
 * `tsc` and `node` are spawned as `node <js entry>` rather than through their
 * bin shims, for the reason `apps/web/scripts/next-on-web-port.ts` documents:
 * the shim is `tsc.CMD` on Windows and `tsc` elsewhere, and papering over that
 * means `shell: true` and then quoting.
 *
 * `--preserveWatchOutput` stops tsc clearing the terminal on every rebuild,
 * which would otherwise wipe the API's own startup log — the output a
 * developer is running this to read.
 *
 * The first compile is run to completion before the server starts. Without it
 * `node --watch` is handed a `dist/main.js` that does not exist yet on a clean
 * checkout, and reports that as the error rather than as "not yet built".
 */
const require = createRequire(import.meta.url);
const tscEntry = require.resolve('typescript/bin/tsc');

const children: ChildProcess[] = [];

function spawnChild(args: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [...args], { stdio: 'inherit' });
  children.push(child);
  return child;
}

function shutdown(code: number): never {
  for (const child of children) child.kill();
  process.exit(code);
}

const firstBuild = spawnChild([tscEntry, '-p', 'tsconfig.build.json']);

firstBuild.on('exit', (code) => {
  if (code !== 0) {
    // A first compile that fails is a real failure, not something to watch
    // through: there is no dist to serve.
    shutdown(code ?? 1);
  }

  const watcher = spawnChild([
    tscEntry,
    '-p',
    'tsconfig.build.json',
    '--watch',
    '--preserveWatchOutput',
  ]);
  const server = spawnChild(['--watch', 'dist/main.js']);

  for (const child of [watcher, server]) {
    child.on('exit', (childCode, signal) => {
      if (signal !== null) shutdown(1);
      shutdown(childCode ?? 0);
    });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown(0);
  });
}
