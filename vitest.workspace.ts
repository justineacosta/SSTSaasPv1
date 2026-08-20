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
]);
