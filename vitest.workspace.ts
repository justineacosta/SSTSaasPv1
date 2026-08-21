import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
      exclude: ['**/*.integration.spec.ts'],
      environment: 'node',
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/src/**/*.integration.spec.ts', 'apps/*/src/**/*.integration.spec.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 120_000,
      fileParallelism: false,
      passWithNoTests: true,
    },
  },
  // React specs render components and need a DOM (jsdom) plus jest-dom's
  // matchers — neither belongs in the 'unit' project above, whose every
  // other member is a plain Node package. A separate project keeps
  // `environment: 'node'` as the default for everything else instead of
  // switching the whole 'unit' project to jsdom.
  //
  // The glob covers packages/*/src and apps/*/src, not just packages/ui:
  // the 'unit' project above only matches `*.spec.ts`, so a `.spec.tsx` file
  // anywhere else (apps/web, once Task 13 lands it) would otherwise match no
  // project at all, and root `pnpm test`'s `--passWithNoTests` would print
  // green while silently executing zero of that package's tests — the exact
  // failure this project exists to rule out for packages/ui (Task 12,
  // Ruling 1). Verified this reaches apps/* too: a temporary
  // apps/web/src/__probe__.spec.tsx matched this project and ran under
  // jsdom with jest-dom's matcher available, resolved via this setupFiles
  // path even though the spec's own directory (apps/web) had no
  // @testing-library/jest-dom of its own — Node resolves the *setup file's*
  // imports against packages/ui's node_modules, not the running spec's.
  // A real apps/web spec that imports @testing-library/react directly will
  // still need that package added as an apps/web devDependency; that's
  // Task 13's to add when the app package exists.
  {
    test: {
      name: 'ui',
      include: ['packages/*/src/**/*.spec.tsx', 'apps/*/src/**/*.spec.tsx'],
      // Mirrors the 'unit' project's exclude above. Without it, a future
      // *.integration.spec.tsx would match this project's include glob and
      // run under jsdom with no 120s timeout and no fileParallelism: false —
      // the unit pass's constraints, not the integration pass's — instead
      // of running under `pnpm test:integration` where it belongs.
      exclude: ['**/*.integration.spec.tsx'],
      environment: 'jsdom',
      setupFiles: ['./packages/ui/src/test-setup.ts'],
      passWithNoTests: true,
    },
  },
]);
