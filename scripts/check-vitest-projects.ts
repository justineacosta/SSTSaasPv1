/**
 * `pnpm check:specs` — every spec file is claimed by exactly one Vitest project.
 *
 * THE TRAP THIS EXISTS FOR. A spec whose filename matches no Vitest project's
 * `include` glob is not an error. `--passWithNoTests` — which `pnpm test` and
 * `pnpm test:integration` both pass — prints green while executing none of it.
 * Task 12 hit three separate spellings of that in one task, and the third was
 * created by the fix round for the second: a `.spec.tsx` outside `packages/ui`,
 * a `.integration.spec.tsx` that the `ui` project's new `exclude` pushed out of
 * every project at once, and so on. `vitest.workspace.ts`'s comments narrate
 * all three. All three instances are closed; the class is not, and patching
 * globs one at a time is losing to it.
 *
 * BOTH DIRECTIONS ARE FAILURES. Zero projects is the silent skip above. Two or
 * more is a file running twice under different environments — which is how a
 * jsdom component spec silently also runs under Node, passing in one and
 * meaning nothing in the other.
 *
 * WHY IT ASKS VITEST INSTEAD OF MATCHING GLOBS ITSELF. Re-deriving Vitest's
 * glob semantics by hand produces a checker that can disagree with Vitest — and
 * it would disagree in the direction of green, which is the direction that
 * costs something. `createVitest()` from `vitest/node` resolves the real
 * projects from the real config, and each project's `globTestFiles()` is the
 * same call that decides what the suite runs. Verified against the installed
 * Vitest 3.2.7: `Vitest.projects` is a `TestProject[]`, and
 * `TestProject.globTestFiles()` resolves to `{ testFiles, typecheckTestFiles }`.
 * That API is marked experimental by Vitest and does not follow semver, which
 * is a real risk — but a wrong answer from it is a loud failure here, not a
 * silent pass, and the alternative is a second implementation that is wrong
 * quietly.
 *
 * Runs in the cheap lane: it resolves and globs, it never executes a test.
 */
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where a spec file may live and still be expected to run under Vitest. */
const SEARCH_GLOBS = [
  'packages/*/**/*.{spec,test}.*',
  'apps/*/**/*.{spec,test}.*',
  'scripts/**/*.{spec,test}.*',
] as const;

/**
 * Directories whose contents are not Vitest's to run.
 *
 * `apps/<app>/e2e` is Playwright's `testDir` (`apps/web/playwright.config.ts`), so
 * a `*.spec.ts` there runs under `pnpm test:e2e` and is *supposed* to match no
 * Vitest project. Everything else here is build output, dependencies, or
 * generated code — none of it authored, none of it a place a real spec lives.
 *
 * Deliberately wider than the ruling asked for. The ruling named
 * `packages/<pkg>/src` and `apps/<app>/src`; this scans the whole of each package,
 * because the trap is "a spec that runs nowhere" and a spec dropped in
 * `apps/web/app/` would be exactly that while sitting outside a `src`-only
 * sweep. Measured: with this exclusion list, today's tree yields no candidate
 * outside those two `src` trees except `apps/web/e2e/smoke.spec.ts`.
 */
const EXCLUDED_SEGMENTS = [
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'generated',
  'test-results',
  'playwright-report',
] as const;

const E2E_DIRECTORY = 'e2e';

/** Normalises a path for comparison — Windows separators, no drive-case games. */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * True when a repository-relative path is not Vitest's to claim.
 *
 * Pure, so the exclusion list is testable rather than a thing that happens to
 * work on one tree.
 */
export function isExcludedSpecPath(relativePath: string): boolean {
  const segments = normalisePath(relativePath).split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment as never))) return true;
  // apps/<name>/e2e/** — Playwright's, not Vitest's.
  return segments[0] === 'apps' && segments[2] === E2E_DIRECTORY;
}

/**
 * The `.test.*` spelling, which this repository bans.
 *
 * Vitest's DEFAULT `include` covers both `.test.` and `.spec.` — but every
 * project in `vitest.workspace.ts` overrides that default with `.spec.`
 * patterns only. So a `.test.ts` file matches no project and executes nothing
 * while `pnpm test` prints green. A review proved it end to end: a
 * `packages/db/src/__probe__.test.ts` asserting `1 === 2` sat in the tree and
 * both `pnpm test` and this check reported OK, exit 0. The sweep only looked
 * for `.spec.*`, so the guard built to end the silent-skip trap was blind to
 * the most natural filename in the ecosystem.
 *
 * The fix is a RENAME, not a wider project include. Two spellings for one
 * concept is how this trap regrows: Task 12 hit three separate spellings and
 * the third was created by the fix round for the second. All 41 spec files in
 * this repository are already `.spec.*`, so the ban costs nothing.
 */
export function findBannedSpellings(candidates: readonly string[]): string[] {
  return candidates.filter((candidate) => /\.test\.[^./]+$/.test(normalisePath(candidate)));
}

/** `a/b/foo.test.ts` -> `a/b/foo.spec.ts`, for the rename instruction. */
export function toCanonicalSpelling(path: string): string {
  return normalisePath(path).replace(/\.test\.([^./]+)$/, '.spec.$1');
}

/** One Vitest project and the files it claims, as the project itself reports them. */
export interface ProjectFiles {
  readonly project: string;
  readonly files: readonly string[];
}

/** A spec file claimed by the wrong number of projects. */
export interface CoverageViolation {
  readonly file: string;
  readonly projects: readonly string[];
}

export interface CoverageResult {
  /** Claimed by no project — runs nowhere, passes green under --passWithNoTests. */
  readonly unclaimed: CoverageViolation[];
  /** Claimed by two or more — runs twice, under different environments. */
  readonly contested: CoverageViolation[];
}

/**
 * Compares the spec files on disk against the files each project claims.
 *
 * Both inputs are already-resolved absolute paths; this function does no
 * globbing of its own, which is the whole point — the matching was done by
 * Vitest.
 */
export function findSpecCoverageViolations(
  candidates: readonly string[],
  projects: readonly ProjectFiles[],
): CoverageResult {
  const claims = new Map<string, string[]>();
  for (const candidate of candidates) claims.set(normalisePath(candidate), []);

  for (const { project, files } of projects) {
    for (const file of files) {
      const key = normalisePath(file);
      const existing = claims.get(key);
      if (existing !== undefined) existing.push(project);
    }
  }

  const unclaimed: CoverageViolation[] = [];
  const contested: CoverageViolation[] = [];
  for (const [file, projectNames] of [...claims.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (projectNames.length === 0) unclaimed.push({ file, projects: [] });
    else if (projectNames.length > 1) contested.push({ file, projects: [...projectNames].sort() });
  }
  return { unclaimed, contested };
}

// ---------------------------------------------------------------------------
// The shell.
// ---------------------------------------------------------------------------

const REPO_ROOT = normalisePath(fileURLToPath(new URL('..', import.meta.url))).replace(/\/$/, '');

function report(lines: readonly string[]): void {
  // A CI check's output contract is what a human reads in a red build log.
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

/** Success goes to stdout; only failures belong on stderr. */
function reportOk(lines: readonly string[]): void {
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Every spec file on disk that Vitest is expected to claim. */
export function findCandidateSpecFiles(root: string): string[] {
  const found = SEARCH_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root }));
  return [...new Set(found.map(normalisePath))]
    .filter((relative) => !isExcludedSpecPath(relative))
    .map((relative) => `${root}/${relative}`)
    .sort();
}

async function main(): Promise<void> {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { watch: false });

  // Globbed exactly once and reused (M6): the disk sweep and the report must
  // describe the same set, and calling it twice invited them to diverge.
  const candidates = findCandidateSpecFiles(REPO_ROOT);
  const banned = findBannedSpellings(candidates);
  const claimable = candidates.filter((candidate) => !banned.includes(candidate));

  let result: CoverageResult;
  let projectNames: string[];
  try {
    const projects: ProjectFiles[] = await Promise.all(
      vitest.projects.map(async (project) => ({
        project: project.name,
        files: (await project.globTestFiles()).testFiles,
      })),
    );
    projectNames = projects.map((project) => project.project);
    result = findSpecCoverageViolations(claimable, projects);
  } finally {
    await vitest.close();
  }

  const lines: string[] = [];

  if (banned.length > 0) {
    lines.push(
      'These files use the `.test.*` spelling, which this repository does not use:',
      '',
      ...banned.map(
        (file) =>
          `  ${file.replace(`${REPO_ROOT}/`, '')}` +
          `
      rename to  ${toCanonicalSpelling(file).replace(`${REPO_ROOT}/`, '')}`,
      ),
      '',
      "Vitest's default include covers both `.test.` and `.spec.`, but every",
      'project in vitest.workspace.ts overrides that default with `.spec.`',
      'patterns only — so a `.test.*` file matches no project and executes',
      'nothing while `pnpm test` prints green.',
      '',
      'RENAME the file. Do not teach a project to claim `.test.*`: two spellings',
      'for one concept is how this trap regrows, and Task 12 hit three of them,',
      'the third created by the fix round for the second.',
      '',
    );
  }

  if (result.unclaimed.length > 0) {
    lines.push(
      'These spec files are claimed by NO Vitest project, so they execute nothing:',
      '',
      ...result.unclaimed.map((violation) => `  ${violation.file.replace(`${REPO_ROOT}/`, '')}`),
      '',
      'This does not fail the suite — `--passWithNoTests` prints green while',
      'running none of it, which is why it needs a check of its own. Fix it by',
      'widening a project include in vitest.workspace.ts, or by renaming the',
      'file to a spelling an existing project already claims. Do not fix it by',
      'deleting the check.',
      '',
    );
  }

  if (result.contested.length > 0) {
    lines.push(
      'These spec files are claimed by MORE THAN ONE Vitest project, so they run',
      'twice under different environments:',
      '',
      ...result.contested.map(
        (violation) =>
          `  ${violation.file.replace(`${REPO_ROOT}/`, '')}  ->  ${violation.projects.join(', ')}`,
      ),
      '',
      'A jsdom component spec that also runs under Node passes in one project and',
      'means nothing in the other. Give exactly one project the claim, usually by',
      'adding an `exclude` to the other.',
      '',
    );
  }

  if (lines.length > 0) {
    report([`check:specs FAILED — projects resolved: ${projectNames.join(', ')}.`, '', ...lines]);
    process.exitCode = 1;
    return;
  }

  // A floor assertion (M3). `OK — 0 spec files` would be a green answer from a
  // check whose entire premise is distrusting silent zeros: a broken glob, a
  // wrong cwd, or a renamed directory would all present as success.
  if (claimable.length === 0) {
    report([
      'check:specs FAILED — the sweep found no spec files at all.',
      '',
      'That is not a repository with no tests; it is a broken sweep. Something',
      'about SEARCH_GLOBS, the exclusion list, or the working directory is wrong.',
      'Reporting OK here would be exactly the silent zero this check exists to',
      'refuse.',
    ]);
    process.exitCode = 1;
    return;
  }

  reportOk([
    `check:specs OK — ${String(claimable.length)} spec files, each claimed by exactly one of: ` +
      `${projectNames.join(', ')}. No banned .test.* spellings.`,
  ]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
