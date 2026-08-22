/**
 * `pnpm check:openapi` — the committed OpenAPI schema cannot drift from what
 * the contracts generate.
 *
 * WHAT THIS DOES *NOT* COVER, said plainly so nobody counts it twice:
 * `apps/api/src/openapi/generate.integration.spec.ts` already asserts the
 * committed file is byte-identical to what the code generates, and asserts a
 * good deal more besides (that the document describes Express's own router,
 * that the health schemas match the bodies actually served). That spec is the
 * stronger test. It runs under `pnpm test:integration`, which needs the whole
 * Docker stack — Postgres, Redis and MinIO — because it builds the real
 * application.
 *
 * This check earns its place by running in the cheap lane instead: it never
 * calls `app.init()`, so it needs no database, no queue and no object storage,
 * only a valid environment for the Nest container to build. A contributor
 * without Docker running, and a CI job that has not yet stood the stack up,
 * both still get told that the contract moved.
 *
 * WHY IT SPAWNS A BUILD RATHER THAN IMPORTING THE GENERATOR. The plan's
 * one-liner — `node scripts/check-openapi-diff.ts` importing
 * `generateOpenApiDocument` directly — does not work, and the reason is not
 * incidental. Generating the document builds the Nest `AppModule`, which reads
 * decorator metadata that Node's type-stripping does not emit;
 * `emitDecoratorMetadata` is a code-generating transform, and type-stripping by
 * definition only erases. `apps/api`'s own `openapi:generate` script exists for
 * this reason: it runs `tsc -p tsconfig.build.json` first and then
 * `node dist/openapi/cli.js`. This check calls that script, so the document it
 * compares is generated from the *current* source rather than from whatever
 * `dist/` happened to hold.
 *
 * IT DOES NOT DIRTY THE WORKING TREE. `cli.ts` takes `--out`, so the document
 * is generated to a temporary file and the committed one is only ever read.
 * There is no restore path to get wrong, on success or on failure.
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One place where the two documents disagree. */
export interface JsonDifference {
  /** A JSON path such as `paths./health/live.get.operationId`. */
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly committed?: string;
  readonly generated?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const render = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/**
 * A structural diff of two parsed JSON documents, leaf by leaf.
 *
 * "Not byte-equal" is not a diff. A reviewer reading a red CI log has to be
 * able to see *which path or field moved*, so this walks both documents and
 * names every leaf that differs, with the value on each side.
 *
 * Arrays are compared by index and treated as leaves when their contents are
 * not both objects, which keeps the output honest about ordering: an OpenAPI
 * `required` array whose members were reordered is a real change to the
 * document, not a cosmetic one.
 */
export function diffJsonValues(
  committed: unknown,
  generated: unknown,
  path = '',
): JsonDifference[] {
  if (isRecord(committed) && isRecord(generated)) {
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(generated)])].sort();
    return keys.flatMap((key) => {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (!(key in committed)) {
        return [{ path: childPath, kind: 'added' as const, generated: render(generated[key]) }];
      }
      if (!(key in generated)) {
        return [{ path: childPath, kind: 'removed' as const, committed: render(committed[key]) }];
      }
      return diffJsonValues(committed[key], generated[key], childPath);
    });
  }

  if (Array.isArray(committed) && Array.isArray(generated)) {
    const length = Math.max(committed.length, generated.length);
    return Array.from({ length }, (_unused, index) => index).flatMap((index) => {
      const childPath = `${path}[${String(index)}]`;
      if (index >= committed.length) {
        return [{ path: childPath, kind: 'added' as const, generated: render(generated[index]) }];
      }
      if (index >= generated.length) {
        return [{ path: childPath, kind: 'removed' as const, committed: render(committed[index]) }];
      }
      return diffJsonValues(committed[index], generated[index], childPath);
    });
  }

  if (render(committed) === render(generated)) return [];
  return [
    {
      path: path === '' ? '(document)' : path,
      kind: 'changed',
      committed: render(committed),
      generated: render(generated),
    },
  ];
}

/**
 * Free prose that no client can depend on, so a change to it is never breaking.
 *
 * `description` and `summary` are human documentation at any depth, and every
 * `info.*` field (title, version, description) describes the document rather
 * than the contract. Adding a field is still additive per §8, so only `removed`
 * and `changed` are ever candidates in the first place.
 */
export function isProseOnlyPath(path: string): boolean {
  if (path.startsWith('info.') || path === 'info') return true;
  const leaf = path.split('.').pop() ?? '';
  return leaf === 'description' || leaf === 'summary';
}

/**
 * True when a difference removes or renames something a client may depend on.
 *
 * Renames show up as one `removed` plus one `added`, so `removed` is the signal
 * either way. `api/conventions.md` §8: removing a field, renaming, changing a
 * type, tightening validation, or changing a status code needs `/api/v2`.
 *
 * Prose-only paths are excluded. The check still FAILS on them — the committed
 * document must match what the code generates either way — but it stops
 * printing a "this needs /api/v2" banner over a typo fix in a docstring. A
 * banner that appears on every cosmetic edit is a banner people learn to skim
 * past, and then it is not there when it matters.
 */
export function hasBreakingDifference(differences: readonly JsonDifference[]): boolean {
  return differences.some(
    (difference) =>
      (difference.kind === 'removed' || difference.kind === 'changed') &&
      !isProseOnlyPath(difference.path),
  );
}

/** Renders the diff for a human staring at a red build. */
export function formatDifferences(differences: readonly JsonDifference[]): string[] {
  return differences.map((difference) => {
    switch (difference.kind) {
      case 'added':
        return `  + ${difference.path}  ${difference.generated ?? ''}`;
      case 'removed':
        return `  - ${difference.path}  ${difference.committed ?? ''}`;
      case 'changed':
        return `  ~ ${difference.path}\n      committed: ${difference.committed ?? ''}\n      generated: ${difference.generated ?? ''}`;
    }
  });
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMITTED = join(REPO_ROOT, 'apps', 'api', 'openapi.json');

/**
 * Where the regenerated document lands. Relative, and passed to the generator
 * as this exact literal.
 *
 * `pnpm run` sets the child's cwd to the package directory, so the generator
 * writes `apps/api/.openapi-check.json`. Nothing derived from the environment
 * ever reaches the command line: on Windows `pnpm` is `pnpm.cmd`, which Node
 * refuses to spawn without a shell (the CVE-2024-27980 mitigation — measured
 * here as `spawnSync pnpm.cmd EINVAL`), and passing an argument array through a
 * shell concatenates it without escaping (DEP0190). A constant argument makes
 * both of those moot rather than merely unlikely.
 *
 * It is gitignored, and removed in a `finally`, so neither a failing run nor a
 * killed one leaves the working tree dirty.
 */
const GENERATED_RELATIVE = '.openapi-check.json';
const GENERATED = join(REPO_ROOT, 'apps', 'api', GENERATED_RELATIVE);

function report(lines: readonly string[]): void {
  // A CI check's entire output contract is what a human reads in a terminal;
  // the structured logger's JSON is the wrong medium for it.
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

/** Success goes to stdout; only failures belong on stderr. */
function reportOk(lines: readonly string[]): void {
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

function main(): void {
  try {
    try {
      execSync(`pnpm --filter @sentinel/api run openapi:generate -- --out ${GENERATED_RELATIVE}`, {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch {
      report([
        '',
        'check:openapi FAILED — could not generate the OpenAPI document.',
        '',
        'This is a build or environment failure, not a contract diff. The',
        'generator runs `tsc -p tsconfig.build.json` and then boots the Nest',
        'container, so it needs the workspace to compile and a valid .env — but',
        'it does NOT need Postgres, Redis or MinIO. The generator’s own output',
        'is above.',
      ]);
      process.exitCode = 1;
      return;
    }

    let committedText: string;
    try {
      committedText = readFileSync(COMMITTED, 'utf8');
    } catch {
      // Without this the reader gets a raw ENOENT stack from Node. It already
      // failed closed, but a stack trace does not tell anyone what to do.
      report([
        'check:openapi FAILED — apps/api/openapi.json is missing.',
        '',
        'The committed OpenAPI document is the contract; there is nothing to',
        'compare the generated one against. If it was deleted by accident,',
        'restore it from git. If this is a fresh checkout that never had one:',
        '',
        '  pnpm --filter @sentinel/api openapi:generate',
        '',
        'then commit the result.',
      ]);
      process.exitCode = 1;
      return;
    }

    const generatedText = readFileSync(GENERATED, 'utf8');

    if (committedText === generatedText) {
      reportOk([
        'check:openapi OK — apps/api/openapi.json is byte-identical to what the contracts generate.',
      ]);
      return;
    }

    const differences = diffJsonValues(
      JSON.parse(committedText) as unknown,
      JSON.parse(generatedText) as unknown,
    );

    const lines = [
      'The committed OpenAPI schema does not match what the contracts generate.',
      'Run `pnpm --filter @sentinel/api openapi:generate` and commit the result.',
      'If this diff removes or renames a field, it is a BREAKING change and needs',
      '/api/v2 — see .claude/api/conventions.md §8.',
      '',
      '  -  committed (apps/api/openapi.json)',
      '  +  generated (from the Zod contracts and the route inventory)',
      '',
    ];

    if (differences.length === 0) {
      // Byte-different but structurally equal: key order or whitespace moved.
      // Worth its own message, because the integration spec asserts byte
      // identity and would fail here too — with a diff nobody can read.
      lines.push(
        '  The two documents parse to the same value but differ in bytes — key',
        '  order or formatting. Regenerate; do not hand-edit.',
      );
    } else {
      lines.push(...formatDifferences(differences));
    }

    if (hasBreakingDifference(differences)) {
      lines.push(
        '',
        'At least one difference REMOVES or CHANGES something. If the committed',
        'document is the shipped contract, that is a breaking change: it needs',
        '/api/v2 and a documented migration, not an in-place edit.',
      );
    }

    report(lines);
    process.exitCode = 1;
  } finally {
    rmSync(GENERATED, { force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
