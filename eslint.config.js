import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'packages/db/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      // coding-standards.md §1 — no `any` without written justification
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // §5 — no floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // §6 — no console.log; use the structured logger
      'no-console': 'error',
      // §6 — no alert/confirm/prompt
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Use the design system dialog.' },
        { name: 'confirm', message: 'Use ConfirmDialog.' },
        { name: 'prompt', message: 'Use a form.' },
      ],
      // §6 — no process.env outside packages/config
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read env only in packages/config.' },
      ],
      // §6 — no unscoped Prisma client outside migrations, seeds, platform admin
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/unscoped', '@sentinel/db/unscoped'],
              message: 'Use the tenant-scoped client. See security/tenant-isolation.md.',
            },
          ],
        },
      ],
    },
  },
  // Root config files (eslint.config.js, vitest.workspace.ts, and any other
  // root *.config.js / *.config.mjs / *.config.ts) belong to no tsconfig
  // project — type-aware rules cannot run on them. Deliberately not added to
  // a tsconfig; lint them type-unaware instead. Without an explicit tsconfig
  // project, typescript-eslint never pulls in @types/node's ambient globals,
  // so Node's ambient identifiers (process, console, __dirname, etc.) must be
  // declared here or `no-undef` (from js.configs.recommended) misfires on
  // legitimate references. This is why root config files like this one and
  // a future apps/web/playwright.config.ts (Task 13) or a root-level config
  // Task 12 may add need `globals.node`.
  {
    files: ['*.config.js', '*.config.mjs', '*.config.ts', 'vitest.workspace.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: js.configs.recommended.rules,
  },
  // packages/config is the one place allowed to touch process.env
  {
    files: ['packages/config/src/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // seeds, migrations, and the tenant client itself may use the unscoped client
  {
    files: [
      'packages/db/src/unscoped.ts',
      'packages/db/src/seed.ts',
      'packages/db/src/tenant-client.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  // tests may assert on console, use the unscoped client to set up fixtures, and
  // read process.env directly to build child-process environments for Prisma
  // migrations and Testcontainers — a test harness is not application code.
  {
    files: ['**/*.spec.ts', '**/*.integration.spec.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
    },
  },
);
