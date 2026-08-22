import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findBannedSpellings,
  findCandidateSpecFiles,
  findSpecCoverageViolations,
  isExcludedSpecPath,
  normalisePath,
  toCanonicalSpelling,
  type ProjectFiles,
} from './check-vitest-projects.js';

describe('normalisePath', () => {
  it('turns Windows separators into forward slashes so both sides compare', () => {
    expect(normalisePath('E:\\repo\\packages\\ui\\a.spec.tsx')).toBe(
      'E:/repo/packages/ui/a.spec.tsx',
    );
  });
});

describe('isExcludedSpecPath', () => {
  it('keeps a real package spec', () => {
    expect(isExcludedSpecPath('packages/ui/src/components/Button.spec.tsx')).toBe(false);
  });

  it('keeps a spec outside src, which is the whole reason the sweep is wide', () => {
    expect(isExcludedSpecPath('apps/web/app/page.spec.tsx')).toBe(false);
  });

  it('excludes Playwright’s e2e directory, which is not Vitest’s to claim', () => {
    expect(isExcludedSpecPath('apps/web/e2e/smoke.spec.ts')).toBe(true);
  });

  it('does not exclude a directory merely named e2e deeper in a package', () => {
    // Only apps/<name>/e2e is Playwright's testDir. A nested one is not.
    expect(isExcludedSpecPath('packages/ui/src/e2e/thing.spec.ts')).toBe(false);
  });

  it('excludes dependencies and build output', () => {
    expect(isExcludedSpecPath('packages/ui/node_modules/x/a.spec.ts')).toBe(true);
    expect(isExcludedSpecPath('packages/db/dist/a.spec.js')).toBe(true);
    expect(isExcludedSpecPath('apps/web/.next/a.spec.js')).toBe(true);
    expect(isExcludedSpecPath('packages/db/generated/a.spec.js')).toBe(true);
  });
});

describe('findSpecCoverageViolations', () => {
  const unit: ProjectFiles = { project: 'unit', files: ['/r/packages/db/src/id.spec.ts'] };
  const ui: ProjectFiles = { project: 'ui', files: ['/r/packages/ui/src/Button.spec.tsx'] };

  it('returns nothing when every candidate is claimed exactly once', () => {
    expect(
      findSpecCoverageViolations(
        ['/r/packages/db/src/id.spec.ts', '/r/packages/ui/src/Button.spec.tsx'],
        [unit, ui],
      ),
    ).toEqual({ unclaimed: [], contested: [] });
  });

  it('reports a file no project claims — the silent-skip trap', () => {
    // The exact Task 12 failure: the file exists, the suite is green, and
    // nothing in it ever executed.
    const result = findSpecCoverageViolations(
      ['/r/packages/ui/src/__probe__.spec.jsx', '/r/packages/db/src/id.spec.ts'],
      [unit, ui],
    );
    expect(result.unclaimed).toEqual([
      { file: '/r/packages/ui/src/__probe__.spec.jsx', projects: [] },
    ]);
    expect(result.contested).toEqual([]);
  });

  it('reports a file two projects claim — running twice under two environments', () => {
    const result = findSpecCoverageViolations(
      ['/r/packages/ui/src/Button.spec.tsx'],
      [{ project: 'unit', files: ['/r/packages/ui/src/Button.spec.tsx'] }, ui],
    );
    expect(result.contested).toEqual([
      { file: '/r/packages/ui/src/Button.spec.tsx', projects: ['ui', 'unit'] },
    ]);
    expect(result.unclaimed).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const result = findSpecCoverageViolations(
      ['/r/a.spec.jsx', '/r/b.spec.mts', '/r/packages/db/src/id.spec.ts'],
      [unit],
    );
    expect(result.unclaimed.map((violation) => violation.file)).toEqual([
      '/r/a.spec.jsx',
      '/r/b.spec.mts',
    ]);
  });

  it('compares across path separators, so a Windows candidate matches a posix claim', () => {
    expect(findSpecCoverageViolations(['\\r\\packages\\db\\src\\id.spec.ts'], [unit])).toEqual({
      unclaimed: [],
      contested: [],
    });
  });

  it('ignores a project claim for a file that is not a candidate', () => {
    // A project may legitimately claim something outside the sweep; that is
    // not this check's business and must not crash it.
    expect(
      findSpecCoverageViolations([], [{ project: 'unit', files: ['/elsewhere/x.spec.ts'] }]),
    ).toEqual({ unclaimed: [], contested: [] });
  });
});

// ---------------------------------------------------------------------------
// C1 regression — the `.test.*` spelling.
//
// A review put `packages/db/src/__probe__.test.ts` containing
// `expect(1).toBe(2)` in the tree. `pnpm test` printed 375 passed and
// `check:specs` printed OK: both green, the failing test never executed. The
// sweep only looked for `.spec.*`, so the guard built to end the silent-skip
// trap was blind to the most natural filename in the ecosystem.
// ---------------------------------------------------------------------------

describe('findBannedSpellings', () => {
  it('flags the exact file the review used', () => {
    expect(findBannedSpellings(['/r/packages/db/src/__probe__.test.ts'])).toEqual([
      '/r/packages/db/src/__probe__.test.ts',
    ]);
  });

  it('flags every .test extension, not just .ts', () => {
    expect(findBannedSpellings(['/r/a.test.tsx', '/r/b.test.js', '/r/c.test.mts'])).toHaveLength(3);
  });

  it('leaves canonical .spec files alone', () => {
    expect(findBannedSpellings(['/r/a.spec.ts', '/r/b.integration.spec.tsx'])).toEqual([]);
  });

  it('does not flag a file merely containing the word test', () => {
    expect(
      findBannedSpellings(['/r/test-setup.ts', '/r/latest.spec.ts', '/r/tests/a.spec.ts']),
    ).toEqual([]);
  });
});

describe('toCanonicalSpelling', () => {
  it('renders the rename instruction the failure message prints', () => {
    expect(toCanonicalSpelling('/r/packages/db/src/auth.test.ts')).toBe(
      '/r/packages/db/src/auth.spec.ts',
    );
  });

  it('preserves the extension', () => {
    expect(toCanonicalSpelling('/r/a.test.tsx')).toBe('/r/a.spec.tsx');
  });
});

describe('the candidate sweep itself, against a real directory tree', () => {
  // A fixture tree rather than the repository itself: this must keep pinning
  // the glob even once the repo contains no `.test.*` file, which is exactly
  // the state the ban is meant to maintain.
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = normalisePath(mkdtempSync(join(tmpdir(), 'sentinel-specs-')));
    const src = join(fixtureRoot, 'packages', 'db', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, '__fixture__.spec.ts'), '', 'utf8');
    writeFileSync(join(src, '__fixture__.test.ts'), '', 'utf8');
    const excluded = join(fixtureRoot, 'packages', 'db', 'node_modules');
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(excluded, 'dep.spec.ts'), '', 'utf8');
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const relative = (root: string): string[] =>
    findCandidateSpecFiles(root).map((file) => file.replace(`${root}/`, ''));

  it('finds a real .test.* file on disk, not only .spec.*', () => {
    // Pins the SEARCH_GLOBS widening. Narrow the glob back to `*.spec.*` and
    // this fails — which is the point, because narrowing it is invisible
    // everywhere else, including to `pnpm test`.
    expect(relative(fixtureRoot)).toContain('packages/db/src/__fixture__.test.ts');
  });

  it('finds .spec.* files in the same sweep', () => {
    expect(relative(fixtureRoot)).toContain('packages/db/src/__fixture__.spec.ts');
  });

  it('still applies the exclusion list', () => {
    expect(relative(fixtureRoot)).not.toContain('packages/db/node_modules/dep.spec.ts');
  });

  it('classifies exactly the .test.* one as banned', () => {
    expect(
      findBannedSpellings(findCandidateSpecFiles(fixtureRoot)).map((f) => f.split('/').pop()),
    ).toEqual(['__fixture__.test.ts']);
  });
});
