# Task 16 — the authentication screens: implementer's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-04, on branch `feat/phase-2-task-16-auth-screens`, cut from
`main` at `e6a9c68`. Mode: fresh implementer subagent + separate fresh adversarial reviewer. The
plan calls Task 16 "chained with 17"; sessions do not persist, so there is no warm implementer to
chain to and the chain is being executed as two briefed tasks instead.

## The two rules that bind you before any code

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative. Raw evidence goes up; the
   orchestrator writes every sentence that asserts anything. Execution protocol §3, review-blocking.
2. **Cite before you claim.** Every factual assertion about this repository carries the command or
   the file-and-line that establishes it. Do not assume another task's change landed — open the
   file. A correction is a claim too: re-run the check after a fix rather than describing the fix
   from memory.

## Write the report as you go, not at the end

Ruling 131, and it cost this phase an entire review pass. A subagent that holds its findings until
the end and is killed by a session limit loses everything. **Create
`docs/superpowers/ledger/phase-2/task-16/report.md` in your first few minutes and append to it
after each meaningful step, committing as you go.** The document is the first artefact, not the
last.

## What already exists, so you do not rebuild it

Measured on this branch. Verify each rather than trusting this list.

- **The `(auth)` route group exists and has no routes under it.** `apps/web/app/(auth)/layout.tsx`
  is a centred single-column shell whose docblock says so explicitly. `find apps/web/app -type f`
  returns eleven files; the only pages are the marketing landing page and the `(app)/dashboard`
  placeholder.
- **Every contract you need is already written**, in `packages/contracts/src/auth.ts` and exported
  from `packages/contracts/src/index.ts`: `registerRequestSchema`, `verifyEmailRequestSchema`,
  `resendVerificationRequestSchema`, `loginRequestSchema`, `loginResponseSchema`,
  `mfaVerifyRequestSchema`, `forgotPasswordRequestSchema`, `resetPasswordRequestSchema`,
  `sessionResponseSchema`, `errorEnvelopeSchema`, `fieldErrorSchema`, plus `passwordSchema`,
  `emailSchema`, `mfaCodeSchema`, `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH`. **Use them as
  the resolver schemas. Do not re-declare a single field shape in `apps/web`** — that shared schema
  is the entire point of `packages/contracts` being the spine. If one is genuinely wrong, say so
  with the measurement and stop.
- **`loginResponseSchema` is a discriminated union on `mfaRequired`** —
  `{ mfaRequired: false }` or `{ mfaRequired: true, pendingToken: string }`
  (`packages/contracts/src/auth.ts:145-148`). That union is the login screen's branch.
- **Eight UI primitives exist** in `packages/ui`: `Button`, `Input`, `Label`, `Field`, `Card`,
  `Alert`, `Badge`, `Skeleton`. `Field` already wires label, description and error together with
  `aria-describedby` and sets `aria-invalid` only when there is an error
  (`packages/ui/src/components/Field.tsx`). **Five of the eight have never been painted by a
  browser.** Expect defects jsdom cannot show, and fix them in `packages/ui` rather than working
  around them in the page.
- **The API is live and complete for these screens.** `POST /api/v1/auth/register`,
  `verify-email`, `resend-verification`, `login`, `mfa/verify`, `forgot-password`,
  `reset-password`, and `GET /api/v1/auth/session`. Confirm with
  `node -e "const o=require('./apps/api/openapi.json');console.log(Object.keys(o.paths))"`.
- **`apps/web` currently has no test of its own.** The `ui` Vitest project's glob is
  `apps/*/src/**/*.spec.tsx` (`vitest.workspace.ts`), so a spec under `apps/web/src` is already
  claimed — but the comment at that glob records that **a real spec importing
  `@testing-library/react` directly still needs that package as an `apps/web` devDependency.**
  Adding it is yours.

## The decisions already taken. Do not re-open these.

- **ADR-0024 (written today, read it):** the API base URL reaches the browser as a **prop from a
  server component**, not as a `NEXT_PUBLIC_` variable. `apps/web/src/env.ts` parses
  `webEnvSchema`, which declares `API_BASE_URL`. The root layout is a server component; pass
  `env.API_BASE_URL` into the client provider tree and have the API client read it from context.
  **Do not add a `NEXT_PUBLIC_` variable and do not read `process.env` anywhere** — the
  `no-restricted-properties` rule at `eslint.config.js:50-53` forbids the second and will fail
  `pnpm lint`.
- **ADR-0017:** the browser calls the API **directly, cross-origin**. There is no Next proxy and
  you are not to build one.
- **Cookie names are `__Host-session` and `__Host-csrf`**, not `session` and `csrf`
  (`apps/api/src/modules/auth/cookies.ts:37,51`). The Task 16 plan text says "the `csrf` cookie";
  **the plan text is stale and the code is right** — `__Host-csrf` is the name. The CSRF cookie
  carries `Secure; SameSite=Lax; Path=/` and **no `HttpOnly`** (`cookies.ts:81`), which is what
  makes double-submit possible: the page can read it from `document.cookie`. The session cookie
  is `HttpOnly` and you will never see it.
- **The CSRF header is `X-CSRF-Token`** (`apps/api/src/common/guards/csrf.guard.ts:12`), attached
  on unsafe methods only.
- **`/login/mfa` is one screen, not two.** The plan lists `/login/mfa`;
  `.claude/ui-ux/page-map.md` additionally lists a separate `/recovery`. **One endpoint serves
  both**: `POST /auth/mfa/verify`'s own OpenAPI description says `code` "accepts a six-digit code
  from the authenticator app OR one of the ten recovery codes"
  (`apps/api/src/modules/auth/auth.controller.ts:900-906`). So build **one** screen with a
  "use a recovery code instead" affordance that switches the input's labelling, `inputMode` and
  `autocomplete`. The orchestrator will correct `page-map.md`; you do not touch `.claude/`.

## What you are building

Six routes under the existing `(auth)` group, plus the client that serves them.

### 1. The typed API client — one place, not per form

`apps/web/src/api/` (name the files as you see fit). It must:

- send `credentials: 'include'` on every request, or the ambient cookie never travels;
- read `__Host-csrf` from `document.cookie` and attach it as `X-CSRF-Token` **on unsafe methods
  only** (POST/PUT/PATCH/DELETE);
- take its base URL from context per ADR-0024;
- parse **every** response body with the contract's response schema before returning it, and parse
  a non-2xx body with `errorEnvelopeSchema`. A response the schema rejects is an error, not a
  value — do not cast;
- map `details.fields` onto field-level errors. The shape is `FieldError[]` —
  `{ path: string; code: string; message: string }` — built by
  `apps/api/src/common/pipes/zod-validation.pipe.ts:91` and carried under `details.fields` for both
  `VALIDATION_ERROR` and `UNKNOWN_FIELD`. A `path` that matches a form field becomes that field's
  error; anything unmatched becomes the form-level error, and **must not be dropped silently**;
- surface `error.requestId` in the error state. `architecture/frontend.md` §6 requires the request
  ID in every error state, for support.

Unit-test this module directly. It is the piece every later task inherits and the one place a
mistake is invisible from the screen.

### 2. The six screens

| Route | Endpoint | Notes |
|---|---|---|
| `/register` | `POST /auth/register` | Answers `{ status: 'VERIFICATION_REQUIRED' }`. Success is a "check your email" state, **not** a redirect to the app — there is no session yet. |
| `/verify-email` | `POST /auth/verify-email` | Token from the query string. This screen submits on load, so it has a real loading state and a real failure state; offer resend (`POST /auth/resend-verification`) on failure. |
| `/login` | `POST /auth/login` | Branch on `mfaRequired`. `false` → go to the intended destination. `true` → carry `pendingToken` to `/login/mfa`. |
| `/login/mfa` | `POST /auth/mfa/verify` | `inputMode="numeric"`, `autocomplete="one-time-code"`. Plus the recovery-code affordance above — a recovery code is not numeric, so the attributes must change with the mode. |
| `/forgot-password` | `POST /auth/forgot-password` | Always answers `{ status: 'RESET_REQUESTED' }`. **The success state must not reveal whether the address exists** — that is the endpoint's whole design and the screen must not undo it. |
| `/reset-password` | `POST /auth/reset-password` | Token from the query string plus the new password. |

**The `pendingToken` must not go in the URL.** It is a credential — a query string lands in
browser history, in the `Referer` header of every subsequent request, and in server logs. Carry it
in memory across the `/login` → `/login/mfa` step. If you cannot make an in-memory hand-off
survive the navigation, **stop and report the constraint** rather than putting a credential in a
query parameter; the orchestrator will decide.

Note the contrast: the `/verify-email` and `/reset-password` tokens **do** arrive in the query
string, because they arrive from a link in an email and there is nowhere else for them to be.
That is the existing design of those endpoints, not something to fix here.

### 3. Redirect-back on session expiry

`user-flows.md` §8 requires that a session expiry returns to login and **restores the intended
destination**. Build it now, while there are few routes. The API answers `401` with
`SESSION_EXPIRED` or `UNAUTHENTICATED` (`packages/contracts/src/error-codes.ts`).

**The redirect target is attacker-controlled input.** Accept only a same-origin *path* — must
start with a single `/`, must not start with `//` or `/\`, no scheme, no host. An open redirect on
the login page is a real finding, and it is the defect this exact feature is famous for. Test the
rejection cases, not just the happy one.

### 4. States and accessibility

`architecture/frontend.md` §6 lists six required states; the plan names four as mandatory here —
**loading, empty, error, success** — and permission/partial do not apply to an unauthenticated
form. Every screen implements the four.

`forms.md` and §4 additionally require: submit disabled while pending, entered data **kept** on
failure (never clear a form because the server said no), and server errors mapped back to the
offending field.

Accessibility is not a later pass: labelled inputs, a visible focus ring, errors tied to their
control with `aria-describedby` (`Field` does this — use it rather than hand-rolling), and a
form-level error region that a screen reader announces.

**Nothing on these screens is a security control.** Every affordance is re-authorised server-side.
Say so in a docblock where it could be misread.

## What you must not do

- **Do not touch `apps/api`, `packages/db`, or any migration.** This task is `apps/web` and
  `packages/ui`. If you believe an API change is required, stop and report it.
- **Do not edit anything under `.claude/`.** The orchestrator owns every document and every
  sentence that asserts something. Report what you think is false; do not fix it.
- **Do not edit `roadmap.md`.** Same rule, and it is the one the phase has broken before.
- **Do not re-declare a contract shape.** Import from `@sentinel/contracts`.
- **Do not weaken the CSP or add `'unsafe-inline'`/`'unsafe-eval'`.** If a library needs one, stop
  and report — that is a decision, not a fix.
- **Do not add a dependency without checking ADR-0013.** `pnpm-workspace.yaml` sets
  `minimumReleaseAge: 1440`; a package published in the last 24 hours will fail to resolve. The
  dependencies this task is expected to need are `react-hook-form`, `@hookform/resolvers`, the
  workspace `@sentinel/contracts`, and `@testing-library/react` / `@testing-library/jest-dom` /
  `@testing-library/user-event` as devDependencies. Anything beyond that list, justify in the
  report.

## Testing

- **Unit (`*.spec.ts` under `apps/web/src`)** — the API client: CSRF attachment on unsafe methods
  and absence on safe ones, `credentials: 'include'`, error-envelope parsing, `details.fields`
  mapping including the unmatched-path case, and the redirect-target validator with its rejection
  cases.
- **Component (`*.spec.tsx`)** — the screens, under the existing `ui` Vitest project. Each of the
  four required states, the login `mfaRequired` branch both ways, and a server field error landing
  on the right input with `aria-describedby` intact.
- **E2E** — `apps/web/e2e/` holds `smoke.spec.ts` (5 tests today). Add what can be asserted
  **without a running API**: each route renders, has no console errors, is reachable, keeps its
  security headers, and does not scroll horizontally at a narrow viewport. **The full
  register→verify→login→MFA journey is Task 18's**, and the phase's exit criterion. Do not claim
  it here.
- **Prove your tests bite.** For at least the CSRF attachment, the redirect-target validator, and
  the `mfaRequired` branch: mutate the implementation, watch the test go red, revert. Record the
  mutation and the result in the report. A test that has never failed has proven nothing.

## Verification — run these, capture real exit codes

Capture outside a pipe: `out=$(pnpm <cmd> 2>&1); code=$?`. `$?` after a pipe reports the last
stage's status, not the command's.

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check:specs        # every new spec must be claimed by exactly one project
pnpm build
pnpm test:e2e           # this task can reach a rendered page; it is not optional
pnpm test:integration   # unchanged expected, but run it — you are not the judge of blast radius
pnpm check:openapi      # expect 27 paths, unchanged: you add no endpoint
pnpm check:secrets
```

Report the numbers, not the adjectives: file and test counts for `test` and `test:integration`,
the spec count for `check:specs`, the path count for `check:openapi`.

`pnpm test:e2e` needs a Playwright browser and builds and starts the web app itself; budget the
minutes rather than skipping the row. The compose stack is already up and healthy.

**One thing you cannot close, and must not claim.** The plan's verify line ends with "**and a
human loads each screen in a browser**". You cannot do that. Run everything else, and say plainly
in the report that the human browser pass is outstanding. Do not substitute a passing jsdom test
for it — the Phase 1 note that these primitives have never been painted is closed by looking.

## Commit discipline

Small commits, frequently, on `feat/phase-2-task-16-auth-screens`. Never commit to `main`. End
commit messages with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
