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

## Step 2 — dependencies added

```
$ pnpm --filter @sentinel/web add @sentinel/contracts@workspace:* react-hook-form@^7.54.0 @hookform/resolvers@^3.10.0
EXIT=0
$ pnpm --filter @sentinel/web add -D @testing-library/react@^16.0.0 @testing-library/jest-dom@^6.6.0 @testing-library/user-event@^14.5.0
EXIT=0
```

Resolved into `apps/web/package.json`:

- dependencies: `@hookform/resolvers ^3.10.0`, `@sentinel/contracts workspace:*`,
  `react-hook-form ^7.87.0`
- devDependencies: `@testing-library/jest-dom ^6.10.0`, `@testing-library/react ^16.3.2`,
  `@testing-library/user-event ^14.6.5`

All six are on the brief's expected list. Nothing beyond it was added. No
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (ADR-0013); both installs exited 0.
`pnpm-workspace.yaml` was **not** modified — no `minimumReleaseAgeExclude` entry appeared.

## Step 3 — the API client and its unit tests

Files created under `apps/web/src/api/`:

| File | What it is |
|---|---|
| `client.ts` | `createApiClient`, `readCookie`, `isSafeMethod`, `CSRF_COOKIE_NAME`, `CSRF_HEADER_NAME` |
| `errors.ts` | `ApiError` (kind / status / code / requestId / fieldErrors), `toApiError`, `readFieldErrors` |
| `field-errors.ts` | `rootSegment`, `distributeFieldErrors`, `formLevelMessage`, `serverFormErrors` |
| `redirect.ts` | `safeRedirectPath`, `loginHrefForDestination`, `isSessionExpiry` |
| `auth-endpoints.ts` | the eight auth calls, each bound to its contract response schema |
| `provider.tsx` | `ApiClientProvider` / `useApiClient` (ADR-0024's context) |
| `client.spec.ts`, `field-errors.spec.ts`, `redirect.spec.ts` | unit tests |

```
$ pnpm vitest run --project unit apps/web/src/api
EXIT=0
 apps/web/src/api/field-errors.spec.ts (15 tests)
 apps/web/src/api/redirect.spec.ts     (33 tests)
 apps/web/src/api/client.spec.ts       (24 tests)
 Test Files  3 passed (3)
      Tests  72 passed (72)
```

One test failed on first run and the failure was real, not a harness problem:
`sessionResponseSchema` rejected the fixture's `userId` because
`packages/contracts/src/ids.ts:8` requires 26 Crockford-base32 characters after the prefix and
the fixture had 25. Fixed the fixture, not the schema. Recorded because it is direct evidence
that the client parses responses rather than casting them.

ADR-0024 compliance, measured rather than asserted:

```
$ grep -rn "process.env\|NEXT_PUBLIC" apps/web/src/api
apps/web/src/api/client.ts:72:   * there is no `NEXT_PUBLIC_` variable and nothing here reads `process.env`.
apps/web/src/api/provider.tsx:14: * `NEXT_PUBLIC_` variable. The ADR names the ergonomic cost out loud - every
```

Two hits, both inside docblocks; no code reads either. The base URL reaches the client only as
a constructor argument to `createApiClient`, which `app/providers.tsx` supplies from a prop.

## Step 4 — the CSP change, isolated so it can be reverted alone

**This is the one change in this task the brief did not authorise in advance, and it is
committed on its own so the orchestrator can drop it with one `git revert`.**

Before: `apps/web/src/security-headers.ts:81` emitted `connect-src 'self'` unconditionally.
After: `buildSecurityHeaders(nonce, enforceCsp, apiOrigin?)` — a **third, optional** parameter.
Omitted, the directive is byte-identical to before. Supplied, it becomes
`connect-src 'self' <origin>`.

`apps/web/proxy.ts:44` supplies it from `apps/web/src/env.ts`'s new
`apiOrigin = new URL(env.API_BASE_URL).origin`, which is the same schema-validated variable
`apps/api` builds its CORS allowlist from (ADR-0017), so the two cannot name different origins.

What this is NOT: no `'unsafe-inline'`, no `'unsafe-eval'`, no wildcard, no scheme-only source,
no other directive touched. Four new assertions in `security-headers.spec.ts` pin exactly that,
including a whole-list diff proving the widened policy differs from the narrow one in
`connect-src` and nowhere else.

Why it was made rather than only reported: without it the six screens cannot reach the API in
any environment where the policy enforces, which is every environment except local development
(`apps/web/src/env.ts`, `enforceCsp`) — the Playwright suite included, since `start:e2e` pins
`APP_ENV=test`. The screens would have been untestable and unusable, and the brief's own
verification list requires `pnpm test:e2e` to reach a rendered page. It is flagged here rather
than described as obviously correct.

```
$ pnpm vitest run --project unit apps/web/src
EXIT=0
 apps/web/src/security-headers.spec.ts (15 tests)   <- was 11
 apps/web/src/csp-report.spec.ts       (34 tests)
 apps/web/src/api/field-errors.spec.ts (15 tests)
 apps/web/src/api/redirect.spec.ts     (33 tests)
 apps/web/src/api/client.spec.ts       (24 tests)
 Test Files  5 passed (5)
      Tests  121 passed (121)
```

## Step 5 — the six screens

Created under `apps/web/src/auth/` (components, so a `.spec.tsx` can reach them) and
`apps/web/app/(auth)/` (thin route files):

| Route file | Screen component | Endpoint |
|---|---|---|
| `app/(auth)/register/page.tsx` | `src/auth/RegisterScreen.tsx` | `POST /api/v1/auth/register` |
| `app/(auth)/verify-email/page.tsx` | `src/auth/VerifyEmailScreen.tsx` | `verify-email` + `resend-verification` |
| `app/(auth)/login/page.tsx` | `src/auth/LoginScreen.tsx` | `POST /api/v1/auth/login` |
| `app/(auth)/login/mfa/page.tsx` | `src/auth/MfaScreen.tsx` | `POST /api/v1/auth/mfa/verify` |
| `app/(auth)/forgot-password/page.tsx` | `src/auth/ForgotPasswordScreen.tsx` | `POST /api/v1/auth/forgot-password` |
| `app/(auth)/reset-password/page.tsx` | `src/auth/ResetPasswordScreen.tsx` | `POST /api/v1/auth/reset-password` |

Supporting modules: `src/auth/AuthCard.tsx` (shell + `FormErrorRegion`, which renders the
request ID), `src/auth/PasswordField.tsx` (reveal toggle, no paste blocking),
`src/auth/MfaChallengeProvider.tsx` (the in-memory `pendingToken` hand-off),
`src/auth/server-errors.ts`, `src/auth/search-params.ts`.

Wiring changed: `app/layout.tsx` passes `env.API_BASE_URL` to `Providers`; `app/providers.tsx`
takes `apiBaseUrl` and wraps the tree in `ApiClientProvider`; `app/(auth)/layout.tsx` wraps its
children in `MfaChallengeProvider`.

### `pendingToken` does not go in the URL

`MfaChallengeProvider` is rendered by the `(auth)` layout, which `/login` and `/login/mfa`
share, so `router.push('/login/mfa')` keeps it mounted and the token crosses in memory. The
cost is stated rather than hidden: a reload or a direct visit to `/login/mfa` loses the
challenge, which is why that screen has a real empty state sending the user back to `/login`.
The brief's escape hatch ("stop and report if you cannot make an in-memory hand-off survive the
navigation") was **not** needed.

### Two defects found in `packages/ui` by the first real form rendered against it

1. **`FieldProps.description` and `FieldProps.error` were `?: string`.** Under
   `tsconfig.base.json`'s `exactOptionalPropertyTypes`, that **refuses** an explicit
   `undefined`, so the natural call site `error={errors.email?.message}` — a
   `string | undefined` — does not compile. Eight `TS2375` errors across six screens, all from
   this one declaration. Fixed in `packages/ui/src/components/Field.tsx` by writing
   `| undefined` out, per the brief's instruction to fix `packages/ui` rather than work around
   it in the page.

```
$ pnpm --filter @sentinel/web typecheck     # before the fix
EXIT=2   9 errors (8 x TS2375 on FieldProps, 1 x TS2493 in a spec fixture)
$ pnpm build:packages && pnpm --filter @sentinel/web typecheck    # after
EXIT=0
```

2. Nothing else in `packages/ui` needed changing for these screens. Its API was otherwise
   usable as written.

### Build

```
$ pnpm --filter @sentinel/web build
EXIT=0
Route (app)
 f /  f /_not-found  f /api/csp-report  f /api/health  f /dashboard
 f /forgot-password  f /login  f /login/mfa  f /register  f /reset-password  f /verify-email
```

All six new routes present; all `f (Dynamic)`, which is what `force-dynamic` in the root layout
requires of them (`architecture/frontend.md` §2).

### Lint fixes made during this step

- `apps/web/src/api/redirect.ts` needed an `eslint-disable-next-line no-control-regex` with a
  written reason: the pattern matches control characters on purpose, which is what the rule
  exists to catch happening by accident.
- Two `no-unnecessary-type-assertion` errors in `client.spec.ts`, removed by `eslint --fix`.

```
$ npx eslint .    # in apps/web
EXIT=0
```
