import { describe, expect, it } from 'vitest';
import {
  findSpecCoverageViolations,
  isExcludedSpecPath,
  normalisePath,
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
