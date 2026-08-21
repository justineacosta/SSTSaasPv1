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
  // packages/ui's specs render React components and need a DOM (jsdom) plus
  // jest-dom's matchers — neither belongs in the 'unit' project above, whose
  // every other member is a plain Node package. A separate project keeps
  // `environment: 'node'` as the default for everything else instead of
  // switching the whole 'unit' project to jsdom for one package's sake, and
  // keeps the jest-dom setup file (and packages/ui's devDependency on it)
  // from being loaded for packages that never installed it.
  {
    test: {
      name: 'ui',
      include: ['packages/ui/src/**/*.spec.tsx'],
      environment: 'jsdom',
      setupFiles: ['./packages/ui/src/test-setup.ts'],
      passWithNoTests: true,
    },
  },
]);
