import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';
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
      // Each package's tsconfig.json (the one this project service discovers)
      // includes every src/**/*.ts, spec files included — so the project
      // service always finds them, at any nesting depth. Emission is kept
      // spec-free by a separate tsconfig.build.json instead of by excluding
      // specs from the main tsconfig. See packages/config/tsconfig.json vs.
      // packages/config/tsconfig.build.json for the split.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      // coding-standards.md §1 — no `any` without written justification
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Destructuring a key off an object purely to omit it from a `...rest`
      // (a common way to build negative-case test fixtures) is not dead code.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
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
      //
      // M5 (Task 6 review): this codebase's imports are all ESM-relative
      // with an explicit `.js` extension (`verbatimModuleSyntax` in
      // tsconfig.base.json), so a bare `**/unscoped` glob never matches an
      // actual import specifier here — every real import is `./unscoped.js`
      // or similar. Verified empirically: a probe file importing from
      // `../unscoped.js` outside the exemption list below produced zero
      // lint errors under the old pattern. `**/unscoped.js` closes that gap.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/unscoped', '**/unscoped.js', '@sentinel/db/unscoped'],
              message: 'Use the tenant-scoped client. See security/tenant-isolation.md.',
            },
          ],
        },
      ],
    },
  },
  // Config files that belong to no tsconfig project — type-aware rules cannot
  // run on them. Deliberately not added to a tsconfig; lint them type-unaware
  // instead. Without an explicit tsconfig project, typescript-eslint never
  // pulls in @types/node's ambient globals, so Node's ambient identifiers
  // (process, console, __dirname, etc.) must be declared here or `no-undef`
  // (from js.configs.recommended) misfires on legitimate references. That is
  // what `globals.node` is for.
  //
  // **These globs are root-only, and that is not a typo.** An earlier version
  // of this comment claimed the block would also cover "a future
  // apps/web/playwright.config.ts (Task 13)". It does not: under ESLint flat
  // config a pattern with no `/` is resolved against the config's base path
  // and matches only that one directory level, so `*.config.ts` matches
  // `./next.config.ts`-style root files and never `apps/web/*.config.ts`.
  // Verified with `eslint --print-config apps/web/playwright.config.ts` once
  // that file existed: the printed config had `no-undef` off (from
  // typescript-eslint's eslint-recommended, not from this block), no `process`
  // in `languageOptions.globals`, and `@typescript-eslint/no-floating-promises`
  // still at `error` — i.e. this block did not apply and type-aware linting
  // did.
  //
  // Nothing needed fixing for apps/web's TypeScript config files, because
  // apps/web/tsconfig.json includes `**/*.ts` — next.config.ts,
  // playwright.config.ts, proxy.ts and e2e/** are all inside a real project,
  // so `projectService` type-checks them like any other source file, which is
  // strictly better than the fallback this block provides. `postcss.config.mjs`
  // is the one exception: it is not TypeScript, no tsconfig can include it,
  // and without an entry here the project service refuses to parse it at all.
  {
    files: [
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
      'vitest.workspace.ts',
      'apps/*/postcss.config.mjs',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: js.configs.recommended.rules,
  },
  // packages/config is the one place allowed to touch process.env
  {
    files: ['packages/config/src/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // packages/db/src/seed.ts is a CLI script (`pnpm db:seed`), not a request
  // handler — it reads DIRECT_DATABASE_URL/DATABASE_URL directly to build its
  // own Prisma connection before any application code (including
  // packages/config's loader) would otherwise run. One of the three
  // documented exemptions in coding-standards.md §6/database.md §8 alongside
  // migrations and platform admin.
  {
    files: ['packages/db/src/seed.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // seeds, migrations, and the tenant client itself may use the unscoped client.
  // tenant-transaction.ts only ever imports unscoped's `PrismaClient` as a
  // *type* (it needs it to type `base`/`tx`; it never calls
  // createUnscopedPrismaClient), but the base `no-restricted-imports` rule
  // does not distinguish type-only imports from value ones, so it needs the
  // same exemption. Chose the file-exemption route over a rule-level
  // "allow type-only imports of unscoped" carve-out because only this one
  // file needs it — a blanket type-import allowance would be a wider hole
  // than the one problem it's fixing.
  {
    files: [
      'packages/db/src/unscoped.ts',
      'packages/db/src/seed.ts',
      'packages/db/src/tenant-client.ts',
      'packages/db/src/tenant-transaction.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  // apps/api/src/infrastructure/prisma is the API's composition root for the
  // database connection: it constructs the one base client the process owns, so
  // that createTenantClient can wrap it per request and a handler can only ever
  // receive a tenant-scoped client. Exempted at the directory level rather than
  // by an inline directive so the exemption is visible in one place next to the
  // others, and so it cannot silently spread to a sibling module.
  {
    files: ['apps/api/src/infrastructure/prisma/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // tests may assert on console, use the unscoped client to set up fixtures, and
  // read process.env directly to build child-process environments for Prisma
  // migrations and Testcontainers — a test harness is not application code.
  // packages/db/src/testing is the shared Testcontainers harness (Task 6):
  // not itself a spec file, but reused by every integration spec for exactly
  // this reason, so it gets the same exemption. apps/api/src/testing is the
  // same thing for the API: it builds the real application for a spec, which
  // means loading `.env` and pinning NODE_ENV/APP_ENV to `test`.
  {
    files: [
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.integration.spec.ts',
      'packages/db/src/testing/**/*.ts',
      'apps/api/src/testing/**/*.ts',
      // Playwright's own config is harness too: it reads `CI` to decide
      // retries, reporter, and whether an already-running dev server may be
      // reused. That is a property of the machine running the tests, not
      // application configuration, and it is read before any Sentinel code
      // loads — `packages/config`'s schema has no business describing it.
      'apps/*/playwright.config.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
    },
  },
  // React hooks (Task 14). Nothing in the toolchain checked a dependency array
  // until this block existed: `apps/web/app/providers.tsx` has three hooks with
  // dependency arrays and a lazy `useState` initialiser, and the Task 13 review
  // confirmed they are correct *today* — so this is a missing guard over the
  // most common React defect class, not a fix for a present bug.
  //
  // Scoped to the two packages that actually contain React, not workspace-wide.
  // `apps/api`, `packages/db` and the rest have no components, and a plugin
  // that parses them buys nothing while widening what a lint run can break on.
  //
  // `exhaustive-deps` is raised from the plugin's own `warn` to `error`
  // deliberately. ESLint exits 0 on warnings, so as shipped by
  // `recommended-latest` the rule would print advice in a green build and gate
  // nothing — and the entire reason this arrives in the CI-checks task is to be
  // a gate. `coding-standards.md` §8 is the React section this enforces.
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    // The plugin object by hand, not `configs['recommended-latest'].plugins` —
    // measured: that field is still the legacy `['react-hooks']` string array,
    // and ESLint 9.39.5 rejects it outright ("Flat config requires 'plugins' to
    // be an object"). Only the config's `rules` are reused below.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // ui-ux/design-system.md §7 — "no component may use a raw hex value. A
  // lint rule enforces it." Scoped to packages/ui now and written to also
  // cover apps/web once Task 13 lands it, so a colour literal (in a class
  // string, an inline style, anywhere in .ts/.tsx) has to route through a
  // design token instead — a hardcoded colour is a colour that's wrong in
  // dark mode. This rule only ever sees TypeScript/TSX: the `files` glob is
  // `*.{ts,tsx}`, and ESLint does not lint CSS at all — tokens.css's hex
  // values (the token definitions themselves) are outside its reach
  // entirely, not "exempted" by anything written here.
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}\\b/]',
          message:
            'No raw hex colours — reference a design token custom property instead (e.g. bg-[var(--color-surface)]). See ui-ux/design-system.md §7.',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b/]',
          message:
            'No raw hex colours — reference a design token custom property instead (e.g. bg-[var(--color-surface)]). See ui-ux/design-system.md §7.',
        },
      ],
    },
  },
);
