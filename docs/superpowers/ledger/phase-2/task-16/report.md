# Task 16 — implementer's report

Branch: `feat/phase-2-task-16-auth-screens`. Cut from `main` at `e6a9c68`.
This file is a record of commands run, exit codes, file paths and measurements.
It contains no status prose and asserts nothing the orchestrator has not been
handed the evidence for.

## Step 0 — orientation

Started 2026-09-04.

```
$ git branch --show-current
feat/phase-2-task-16-auth-screens
$ git status --short
(empty)
```

Read, in order: `docs/superpowers/ledger/phase-2/task-16/brief.md`, `CLAUDE.md`,
`.claude/decisions/ADR-0024-...md`, `.claude/decisions/ADR-0017-...md`,
`.claude/architecture/frontend.md`, `.claude/ui-ux/forms.md`,
`.claude/ui-ux/accessibility.md`, `.claude/ui-ux/design-system.md`,
`.claude/ui-ux/page-map.md`.

## Step 1 — measurements taken before writing code

Every line below is a command output or a file-and-line, not a judgement.

### The tree

```
$ find apps/web -type f -not -path '*/node_modules/*' -not -path '*/.next/*' | wc -l
29   (includes .turbo logs, tsbuildinfo, test-results)
```

Authored source before this task: `apps/web/app/{(app)/dashboard/page.tsx,(app)/layout.tsx,
(auth)/layout.tsx,(marketing)/layout.tsx,(marketing)/page.tsx,api/csp-report/route.ts,
api/health/route.ts,fonts.ts,globals.css,layout.tsx,providers.tsx}`,
`apps/web/e2e/smoke.spec.ts`, `apps/web/src/{csp-report.ts,csp-report.spec.ts,env.ts,
logger.ts,security-headers.ts,security-headers.spec.ts}`, plus config files.

`apps/web/app/(auth)/` contained exactly one file, `layout.tsx` — no routes. Confirmed.

### Correction to the brief, item 8 of "What already exists"

The brief says "**`apps/web` currently has no test of its own.**" Two Vitest specs exist under
`apps/web/src` and are claimed by the `unit` project (`*.spec.ts`, not `.tsx`):

```
apps/web/src/csp-report.spec.ts
apps/web/src/security-headers.spec.ts
```

The operative half of the brief's sentence is still exact and is what matters: no `.spec.tsx`
exists in `apps/web`, and `@testing-library/react` is not an `apps/web` devDependency
(`apps/web/package.json` devDependencies: `@playwright/test`, `@tailwindcss/postcss`,
`@types/react`, `@types/react-dom`, `dotenv-cli`, `tailwindcss`, `typescript`).

### Facts the brief asserts, re-verified rather than trusted

| Claim | Command / location | Result |
|---|---|---|
| 27 OpenAPI paths | `node -e "...Object.keys(o.paths)"` | 27 |
| all eight auth endpoints published | same | `/api/v1/auth/{register,verify-email,resend-verification,login,mfa/verify,forgot-password,reset-password,session}` all present |
| cookie names | `apps/api/src/modules/auth/cookies.ts:37`, `:51` | `__Host-session`, `__Host-csrf` |
| CSRF cookie has no `HttpOnly` | `apps/api/src/modules/auth/cookies.ts:81` | `const CSRF_ATTRIBUTES = ['Secure', 'SameSite=Lax', 'Path=/'] as const;` |
| CSRF header name | `apps/api/src/common/guards/csrf.guard.ts:12` | `export const CSRF_HEADER = 'x-csrf-token';` |
| safe methods exempt | `csrf.guard.ts:23` | `new Set(['GET','HEAD','OPTIONS','TRACE'])` |
| `details.fields` shape | `packages/contracts/src/error-envelope.ts:9-13` | `{ path, code, message }` |
| `loginResponseSchema` is a discriminated union | `packages/contracts/src/auth.ts` | `z.discriminatedUnion('mfaRequired', [...])` |
| one MFA endpoint serves TOTP and recovery | `packages/contracts/src/auth.ts` `mfaCodeSchema` docblock: "recovery codes are longer and not numeric" | confirmed |
| `API_BASE_URL` on `webEnvSchema` | `packages/config/src/env.ts:427-431` | present |
| `process.env` banned outside `packages/config` | `eslint.config.js:50-53` | `no-restricted-properties` |
| eight UI primitives | `packages/ui/src/index.ts` | Button, Input, Label, Field, Card, Alert, Badge, Skeleton |

### A blocker found before writing code: `connect-src 'self'`

`apps/web/src/security-headers.ts` builds the CSP. Line reading:

```
"connect-src 'self'",
```

ADR-0017 has the browser call the API **cross-origin** (`API_BASE_URL`, a different origin from
`WEB_BASE_URL`). `connect-src 'self'` forbids exactly that `fetch`. The policy is **enforcing**
whenever `APP_ENV !== 'development'` (`apps/web/src/env.ts`, `enforceCsp`) — which includes the
Playwright suite, which pins `APP_ENV=test` (`apps/web/package.json` `start:e2e`).

This is recorded here rather than described as fixed. What is done about it is in Step N below.

### Where component specs may live

`scripts/check-vitest-projects.ts` scans `apps/*/**/*.{spec,test}.*` and requires exactly one
matching Vitest project. `vitest.workspace.ts`'s `ui` project include glob is
`apps/*/src/**/*.spec.tsx`. A `.spec.tsx` placed under `apps/web/app/` would match **zero**
projects and fail `pnpm check:specs`. Therefore the screen components live under
`apps/web/src/` and `app/(auth)/*/page.tsx` are thin route files.
