# Task 17 — app shell, organisation switcher, `/settings/security`: implementer's brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-07, on branch `feat/phase-2-task-17-app-shell`, cut from
`main` at `5dbab4e`. Mode: one implementer across the whole brief, then a fresh adversarial
reviewer, then a fix round — the operator chose one run over a split.

**This task is full-stack, and that is a deliberate expansion the operator approved.** The plan
scopes Task 17's files to `apps/web` and `packages/ui`, then asks for a feature whose API does not
exist. See §2.

## The two rules that bind you before any code

1. **You report commands and exit codes. You do not write status prose.** No "this now works", no
   summary paragraphs, no `roadmap.md` edits, no `.claude/` narrative. Raw evidence goes up; the
   orchestrator writes every sentence that asserts anything. Execution protocol §3, review-blocking.
2. **Cite before you claim.** Every factual assertion about this repository carries the command or
   the file-and-line that establishes it. Do not assume another task's change landed — open the
   file. A correction is a claim too: re-run the check after a fix rather than describing it from
   memory.

## Write the report as you go

Ruling 131. **Create `docs/superpowers/ledger/phase-2/task-17/report.md` in your first few minutes
and append to it after each step, committing as you go.** A subagent that holds its findings until
the end and is killed loses everything; this has already cost this project one full review pass.

Ruling 135, from the task you are following: **never derive a number you can measure.** Task 16's
report computed its test baseline by subtraction and got five figures wrong. The baseline for this
task, measured on `5dbab4e`: **`pnpm test` 109 files / 1882 tests**, **`check:specs` 137 spec
files**, **`test:integration` 28 files / 521 tests**, **`check:openapi` 27 paths**,
**`check:registry` 15 models**, **`test:e2e` 22 passed**. If you want a "before" number, that is
it — do not recompute one.

## 1. The decision you must build on, and must not re-open

**[ADR-0025](../../../../../.claude/decisions/ADR-0025-authenticated-calls-are-made-from-the-browser.md),
written today. Read it before the shell.**

Every authenticated API call is made **from the browser**, including the shell's own session read.
The `(app)` shell resolves the session client-side through TanStack Query and renders a **skeleton**
until it resolves. **Do not server-render the session, do not forward the `__Host-session` cookie
from a Next server component, and do not add a Next proxy or server action that calls the API.**

The reason is measured, not stylistic: `passwordChange` and `mfaManagement` declare `perIp` as
their **only** scope, 10/hour, `failMode: 'closed'`
(`apps/api/src/common/guards/rate-limit.config.ts:208` and `:303`), and between them they guard all
five routes `/settings/security` is built on. Server-originated calls would share one address
across the whole deployment.

**`apps/web/app/(app)/layout.tsx`'s docblock currently says the shell "fetches the effective
permission set server-side".** ADR-0025 makes that false. Correct that comment — it is in
`apps/web`, so it is yours. **`.claude/architecture/frontend.md` §2's table row says the same
thing and is the orchestrator's to fix; report it, do not touch it.**

## 2. The API you must build first, because the frontend cannot exist without it

`/settings/security` must list active sessions. **That API does not exist.** The only session route
is `GET /api/v1/auth/session`, which returns the *current* session document — verified with
`node -e "const o=require('./apps/api/openapi.json');console.log(Object.keys(o.paths).filter(p=>/session/i.test(p)))"`.

Build three routes on `AuthController`:

| Route | Purpose |
|---|---|
| `GET /api/v1/auth/sessions` | The caller's own live sessions, most recently seen first. |
| `DELETE /api/v1/auth/sessions/:sessionId` | Revoke one of the caller's own sessions. |
| `DELETE /api/v1/auth/sessions` | Revoke every session **except the current one**. |

**No migration is needed and you must not write one.** `model Session` already carries `ip`,
`userAgent`, `lastSeenAt`, `createdAt` and `revokedAt`, and Task 1 already created
`@@index([userId, lastSeenAt(sort: Desc)])` whose comment names this exact use case —
"list / revoke a user's sessions for /settings/security". Read the model before you believe this.
If you conclude a migration is genuinely required, **stop and report**: the operator reviews
migration SQL before it touches a database (execution protocol §5).

**`SessionService` is half-built already**: `revoke(sessionId)`, `revokeAllForUser(...)` and
`revokeAllForUserInOrganization(...)` exist. What is missing is a list method. Extend the service;
do not reach around it into Prisma from the controller.

### Non-negotiables on these three routes

- **A caller may only see and revoke their own sessions.** A session id belonging to another user
  answers **404**, never 403 — 403 confirms the id exists. **A cross-user isolation integration
  test is mandatory** and is the single most important test in this task. Sessions are **user**-owned,
  not tenant-owned (the schema comment says so explicitly and keeps `Session` out of the tenant
  registry), so this is cross-*user* isolation, not cross-tenant. `check:registry` must still
  report **15 models** afterwards — if it changes, you have made `Session` tenant-owned by
  accident.
- **Never return `tokenHash`, or anything derived from it.** The response carries id, ip,
  userAgent, createdAt, lastSeenAt, whether it is the current session, and nothing else. A
  response schema in `packages/contracts` is what enforces this — add one, and do not hand-roll
  the shape in the controller.
- **Revocation is a security-relevant action, so it writes an audit event in the same transaction
  as the change** (`CLAUDE.md` rule 10). Look at how Task 14's membership writes do it and follow
  that shape.
- **Declare a rate-limit class deliberately and justify it in the report.** A route carrying no
  class falls to `generalSession`, which is fail-open with a `perPrincipal` scope — carry-forward
  ruling 55 records that nothing warns when that resolves nothing. These routes are authenticated,
  so `perPrincipal` does resolve; that is an argument you must make explicitly rather than inherit.
- **These are `@AuthenticatedOnly()`, not `@RequirePermission()`.** They are self-service and have
  no organisation. `GET /auth/session` is the precedent — read its docblock for why a permission
  would be wrong here.
- **Revoking the current session** is a real case with a real answer. Decide it, implement it,
  say what you decided and why.
- Regenerate `openapi.json`. **Expect 29 paths, up from 27** — two new paths, one carrying two
  methods. If you get a different number, find out why before continuing.

## 3. The frontend

### The shell and session context

`(app)` fetches `GET /auth/session` once through TanStack Query and provides **principal, active
organisation and permission set** through context. This is TanStack Query's first real use in this
product; it is wired and queries nothing today.

- **A skeleton until the session resolves.** No navigation item, no affordance, nothing
  permission-gated renders before the permission set is known. Rendering a button and withdrawing
  it is the "flash of forbidden UI" `frontend.md` §2 bans, and it is banned no matter where the
  data came from.
- **A 401 sends the user to login with the destination preserved.** Task 16 built `isSessionExpiry`
  and `loginHrefForDestination` in `apps/web/src/api/redirect.ts`, tested, **with no caller**. You
  are the caller. Use them; do not write a second redirect helper.
- **`safeRedirectPath` is a security control** and Task 16's review found a real open redirect in
  it. Do not modify it. If you believe it is wrong, stop and report.

### The organisation switcher

Calls `POST /auth/switch-org`, then **invalidates every cached query**. Stale tenant data rendered
under a new organisation is a tenant-isolation failure the user can see. `frontend.md` §3 says
switching organisations **clears the cache entirely** — do that, not a selective invalidation you
have reasoned about. **Test it**: assert that data cached under organisation A is gone after
switching to B, and prove the test bites by removing the invalidation.

### `/settings/security`

- **Active sessions** — ip, user agent, created, last seen; each revocable; "revoke all others" as
  one action; the current session marked and not accidentally revocable by the "others" action.
- **MFA enrolment and disablement** — the QR code from `otpauthUri`, verification, and the
  **one-time recovery-code display**. `POST /auth/mfa/enroll` returns `{ secret, otpauthUri }`;
  `POST /auth/mfa/confirm` returns ten recovery codes. **There is no UI for this today, which the
  operator's Task 16 browser pass proved by having to call the API directly to enrol a factor.**
- **Password change** — `POST /auth/change-password`.
- **Recovery codes get a screen that states plainly they will not be shown again**, with copy and
  download. `api/authentication.md` §4 requires this for API keys and the same rule applies here.
  A once-only secret rendered without that warning is a support ticket at best.

### `/settings/members`

Member list, role change, removal, pending invitations, invite form. **Every affordance gated on
the permission set, and every one still rejected server-side if called directly.**

**The `usePermission` helper is UX only and its docstring must say so, in those words.** The same
goes for any `<Can>` component. A future reader must not be able to mistake it for a control.

### `/dashboard`

Replace the Phase 1 placeholder's "not built" copy **only as far as is true**. There is still no
product. **Do not build fake metric tiles, mock charts, or placeholder numbers** — the Phase 1
"no mock product UI" rule stands and it is the reason that page says what it says.

## What you must not do

- **Do not edit anything under `.claude/`**, including `roadmap.md`. Report documents the change
  makes false; the orchestrator writes every sentence.
- **Do not write a migration.** See §2.
- **Do not modify `safeRedirectPath` or `buildSecurityHeaders`.** Both were fixed under review in
  Task 16. Report, do not touch.
- **Do not re-declare a contract shape.** Import from `@sentinel/contracts`; add to it if a shape
  is genuinely missing.
- **Do not weaken the CSP.** If something needs `'unsafe-inline'` or `'unsafe-eval'`, stop and
  report — that is a decision, not a fix.
- **Do not add a dependency without checking ADR-0013** (`minimumReleaseAge: 1440`). A QR code
  renderer is the one you are likely to want; justify it in the report, and prefer generating the
  SVG yourself over adding a dependency if that is reasonable.

## Testing

- **Integration, against real Postgres** — the three session routes: the cross-user 404, the
  "revoke all others" leaving exactly the current session live, revocation actually invalidating
  the credential, the audit event written, and `tokenHash` absent from every response.
- **Unit** — the session list service method, and the shell's 401 → login redirect.
- **Component** — the shell's skeleton-before-permissions behaviour, the switcher's cache
  invalidation, the permission gating on `/settings/members`, and the recovery-code screen's
  once-only warning.
- **E2E** — routes render, no console errors, security headers intact, no horizontal scroll at a
  narrow viewport. The authenticated journey against a live API is **Task 18's**; do not claim it.
- **Prove your tests bite.** For at least the cross-user isolation test, the cache invalidation,
  and the permission gating: mutate the implementation, watch the test go red, revert, and record
  the mutation and its output in the report.

## Verify — capture real exit codes outside a pipe

`out=$(pnpm <cmd> 2>&1); code=$?` — `$?` after a pipe reports the last stage's status.

```
pnpm format:check   pnpm lint          pnpm typecheck
pnpm test           pnpm check:specs   pnpm test:integration
pnpm build          pnpm test:e2e      pnpm check:openapi
pnpm check:registry pnpm check:secrets
```

Report numbers, not adjectives. `check:openapi` should read **29 paths**; `check:registry` should
still read **15 models**.

**You cannot do the human browser pass.** Say so plainly rather than substituting a passing test
for it.

## Commit discipline

Small commits, frequently, on `feat/phase-2-task-17-app-shell`. Never on `main`. Each message ends:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```
