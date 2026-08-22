/**
 * Argument parsing for `dist/openapi/cli.js`, kept in its own module so it can
 * be unit-tested without importing `cli.ts` — which boots Nest the moment it is
 * loaded.
 */

/**
 * Resolves `--out <path>`, falling back to the committed artefact's path.
 *
 * `pnpm check:openapi` (`scripts/check-openapi-diff.ts`) needs the document
 * this code generates *without* overwriting the file it is about to compare it
 * against: a check that regenerates over the committed file has destroyed its
 * own evidence before comparing, and leaves the working tree dirty even when it
 * passes.
 *
 * Read from `argv` rather than the environment on purpose —
 * `development/coding-standards.md` §6 confines `process.env` to
 * `packages/config`, and an output path is an invocation detail, not
 * application configuration.
 *
 * A `--out` with no value throws rather than silently falling back: silently
 * writing the committed file when the caller asked for a temp path is exactly
 * the failure this flag exists to prevent.
 */
export function outputPathFromArgv(argv: readonly string[], defaultPath: string): string {
  const index = argv.indexOf('--out');
  if (index === -1) return defaultPath;

  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--out requires a path argument');
  }
  return value;
}
