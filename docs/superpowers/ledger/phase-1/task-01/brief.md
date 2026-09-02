### Task 1: Workspace skeleton, tooling, and green CI

Produces a real-but-empty workspace where `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all succeed, and CI runs them.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.workspace.ts`, `.nvmrc`, `.env.example`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: root scripts `lint`, `typecheck`, `test`, `test:integration`, `build`, `format`; the `@sentinel/*` package namespace; `tsconfig.base.json` as the extend target for every package

- [ ] **Step 1: Create the workspace root files**

`.nvmrc`:
```
26
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`package.json`:
```json
{
  "name": "sentinel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "eslint-import-resolver-typescript": "^4.0.0",
    "eslint-plugin-import": "^2.31.0",
    "prettier": "^3.3.0",
    "turbo": "^2.5.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.20.0",
    "vitest": "^3.0.0"
  }
}
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "endOfLine": "lf"
}
```

`.prettierignore`:
```
pnpm-lock.yaml
dist
.next
.turbo
coverage
packages/db/generated
**/*.md
```

`vitest.workspace.ts`:
```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts'],
      exclude: ['**/*.integration.spec.ts'],
      environment: 'node',
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
    },
  },
]);
```

- [ ] **Step 2: Write the ESLint flat config with the security rules**

`eslint.config.js` — every rule here corresponds to a line in [`.claude/development/coding-standards.md`](../../../../../.claude/development/coding-standards.md) §6:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', 'packages/db/generated/**'] },
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
  // packages/config is the one place allowed to touch process.env
  {
    files: ['packages/config/src/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // seeds, migrations, and the tenant client itself may use the unscoped client
  {
    files: ['packages/db/src/unscoped.ts', 'packages/db/src/seed.ts', 'packages/db/src/tenant-client.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // tests may assert on console and use the unscoped client to set up fixtures
  {
    files: ['**/*.spec.ts', '**/*.integration.spec.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
```

- [ ] **Step 3: Write `.env.example`**

Every variable, with a safe local placeholder and a comment saying what it is for. `.gitignore` already permits this file.

```bash
# ---------------------------------------------------------------------------
# Sentinel — local development environment.
# Copy to .env. These placeholders are safe for LOCAL USE ONLY.
# Never copy a staging or production secret into this file.
# ---------------------------------------------------------------------------

# Runtime -------------------------------------------------------------------
NODE_ENV=development                 # development | test | production
APP_ENV=development                  # development | test | staging | production
LOG_LEVEL=debug                      # debug | info | warn | error | fatal

# Web -----------------------------------------------------------------------
WEB_PORT=3000
WEB_BASE_URL=http://localhost:3000

# API -----------------------------------------------------------------------
API_PORT=3001
API_BASE_URL=http://localhost:3001

# Database ------------------------------------------------------------------
# DATABASE_URL is the least-privileged application role. It is NOT a superuser
# and does NOT have BYPASSRLS, which is what makes row-level security a real
# second layer rather than decoration.
DATABASE_URL=postgresql://sentinel_app:sentinel_app_local@localhost:5432/sentinel?schema=public
# DIRECT_DATABASE_URL owns the schema and is used only by `prisma migrate`.
DIRECT_DATABASE_URL=postgresql://sentinel:sentinel_local@localhost:5432/sentinel?schema=public

# Redis ---------------------------------------------------------------------
REDIS_URL=redis://localhost:6379

# Object storage (MinIO locally, R2/S3 in production) -----------------------
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_REGION=us-east-1
STORAGE_ACCESS_KEY_ID=sentinel_local
STORAGE_SECRET_ACCESS_KEY=sentinel_local_secret
STORAGE_FORCE_PATH_STYLE=true
STORAGE_BUCKET_EVIDENCE=evidence
STORAGE_BUCKET_REPORTS=reports
STORAGE_BUCKET_UPLOADS=uploads
STORAGE_BUCKET_EXPORTS=exports

# Mail (Mailpit locally — nothing leaves the machine) -----------------------
MAIL_HOST=localhost
MAIL_PORT=1025
MAIL_FROM="Sentinel <no-reply@sentinel.local>"
```

- [ ] **Step 4: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.5.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: Integration tests
        run: pnpm test:integration

      - name: Build
        run: pnpm build
```

- [ ] **Step 5: Install and verify every command succeeds**

Run, and read the output rather than assuming:
```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all five exit 0. `pnpm test` reports "No test files found" and exits 0 — that is correct at this stage; there is nothing to test yet.

If `pnpm test` exits non-zero on an empty suite, add `passWithNoTests: true` to both projects in `vitest.workspace.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: pnpm + turborepo workspace with strict TypeScript and CI

Workspace root, shared tsconfig, ESLint flat config carrying the
lint-enforced security rules from coding-standards.md §6, Prettier,
Vitest unit/integration projects, .env.example, and a CI workflow
running install -> lint -> typecheck -> test -> integration -> build.

No product code yet. This exists so that every subsequent commit is
verified from the moment it lands.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

