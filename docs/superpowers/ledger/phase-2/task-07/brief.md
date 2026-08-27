# Phase 2 · Task 7 — Authentication guard, `Principal`, CSRF, CORS · implementer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch. Plan section: Task 7 in
[`../../../plans/2026-08-24-phase-2-identity.md`](../../../plans/2026-08-24-phase-2-identity.md).
Branch: **`feat/phase-2-task-07`**, cut from `feat/phase-2-task-06` at `ccc8cde` — Task 6 is not on
`main`, so this branch stacks on it. **ADR-0017 is already committed** (`7029038`, the first commit
on this branch) — read it first; it is the decision this task implements, not a document written
afterwards.

You built Task 6. This is the other half of the chain, and it is the task the plan says carries the
most documentation ownership of any in Phase 2.

## What you are building

The stage that turns the credential you issued in Task 6 into a `Principal` on the request — and
the three controls that sit around it: the third access declaration, CSRF, and CORS.

**You are still not building an endpoint.** `pnpm check:openapi` must report **4 routes** when you
are finished. Every guard you write is proved against purpose-built controllers through
`apps/api/src/testing/routing-app.ts`, which exists for exactly this reason: the route inventory and
the boot assertion have to be provable against routes that this codebase deliberately does not
contain.

## Deliverables

1. **`apps/api/src/common/guards/authentication.guard.ts`** — resolves the session cookie to a
   `Principal`, attaches it to the request, and distinguishes its two refusals.
2. **`apps/api/src/common/guards/csrf.guard.ts`** — double-submit, bound to the session.
3. **A cookie parser**, wherever it belongs. Carry-forward ruling 54: there is no cookie parser
   anywhere in this codebase and Task 6 deliberately did not write one. `cookies.ts` owns the
   session cookie's name and attributes; the parsing side is yours.
4. **`@AuthenticatedOnly()`** in `common/decorators/access.decorator.ts`, with
   `common/access-assertion.ts` **extended, not relaxed**.
5. **CORS**, per ADR-0017, wired where `configureApp` can cover every response.
6. **The CSRF cookie's issuance**, alongside the session cookie in `cookies.ts`.
7. **Unit and integration specs** for all of it.
8. **The documents named under _Doc ownership_.**

## The behaviour

Read `security/authentication.md` §4, `api/authentication.md` §3 and §6, `security/authorization.md`
§5 and `architecture/backend.md` §3 before you write anything. Where two of them disagree, the
`security/` document wins and you say so in your report.

- **Two refusals, and they must stay distinct.** Missing or unparseable credential → 401
  `UNAUTHENTICATED`. A credential that resolved to a session which is expired or revoked → 401
  `SESSION_EXPIRED`. `api/authentication.md` §6 gives both, and the frontend uses the difference to
  choose between "log in" and "your session ended". All four codes you need
  (`UNAUTHENTICATED`, `SESSION_EXPIRED`, `MFA_REQUIRED`, `CSRF_TOKEN_INVALID`) **already exist in
  both `packages/contracts/src/error-codes.ts` and `api/errors.md` §3** — I checked. You add none,
  so carry-forward ruling 27's two-list problem does not land on you.
- **`@Public()` routes skip authentication entirely** — including the cookie parse. A public route
  must not become 401-able by sending it a malformed cookie.
- **`PENDING_MFA` authenticates nothing except MFA verification**, with 401 `MFA_REQUIRED`
  everywhere else. The MFA endpoint does not exist until Task 11 and the session endpoint does not
  exist until Task 9, so **you cannot write this as an exception for a path that exists.** Build the
  mechanism — a declaration a route carries — and prove it against test controllers: a pending
  session reaching an ordinary authenticated route gets `MFA_REQUIRED`, and a pending session
  reaching the route that carries the declaration is allowed through. **A pending credential that
  can read anything is the whole MFA bypass**, and Task 6's ruling 50 closed only the other half of
  it (a pending session can no longer be *promoted* without evidence; nothing yet constrains what it
  may *do*).
- **CSRF: double-submit per §4.** A non-`HttpOnly` `__Host-csrf` cookie, echoed in `X-CSRF-Token`,
  compared with `crypto.timingSafeEqual`, **bound to the session** so a token minted for one session
  does not validate another. Cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` only; safe methods
  and bearer-authenticated requests are exempt. Missing or mismatched → 403 `CSRF_TOKEN_INVALID`.
  Note that `security/authentication.md` §4 names the cookie `csrf` while the plan names it
  `__Host-csrf`; take the prefixed name, which is strictly stronger, and correct §4 in this task —
  it is yours.
  **`timingSafeEqual` throws on length mismatch**, which is the obvious way to reintroduce the
  timing leak the function exists to remove. Compare lengths in constant time or hash both sides
  first; whichever you choose, a test must cover unequal-length input.
- **`Origin` and `Sec-Fetch-Site` are a secondary signal, not the control** — §4 says so explicitly.
  They refuse an obviously cross-site request; the double-submit is what actually holds. **The
  comment must say this**, or a later reader deletes the double-submit as redundant. This is not
  hypothetical: it is the shape of Phase 1's twelve prose defects.
- **CORS per ADR-0017**: exact-match allowlist containing `WEB_BASE_URL` alone, `credentials: true`,
  methods and request headers enumerated. Never reflect the request `Origin`, never `*` with
  credentials. **Add the spec asserting an unknown origin receives no `Access-Control-Allow-Origin`
  header at all** — not a header naming a different origin, none.

## Rulings taken before dispatch

A ruling is a floor, not a ceiling. If you find a better answer, take it and say so in your report
with the reason. What you may not do is silently ignore one.

**Ruling A — guard order is authentication *after* the rate limiter, and you do not change it.**
`architecture/backend.md` §3's table puts Rate limit before Authenticate, and `app-setup.spec.ts`
asserts the pipeline on the path production takes. Keep it. An unauthenticated flood carrying a
garbage cookie would otherwise buy a Redis lookup and a Postgres lookup per request before anything
refused it. Whatever ordering you end up with **must be asserted by a test**, because `APP_GUARD`
order is array order in `app.module.ts` and nothing else makes it visible.

**Ruling B — the plan's rate-limit item cannot be built as written, and here is what you do
instead.** The plan says to wire the `login`, `registration`, `passwordReset` and
`emailVerificationResend` classes to the auth routes and to update `abuse-prevention.md` because its
"governing nothing" banner stops being true. **Those routes do not exist** — Tasks 8, 9 and 10 build
them — so there is nothing to annotate and the banner does **not** stop being true in this task. I
verified the rest before writing this: all four of those classes key on `perIp` and on
`principalSource: { bodyField: 'email' }`, so **none of them needs a principal**, and the tasks that
create those routes can annotate them without anything from you.

What is genuinely yours is the other half: `generalSession` and `generalApiKey` key on
`principalSource: 'authenticated'`, which reads `request.principalId` — a field
`rate-limit.guard.ts:25` documents as "set by authentication, which arrives in Phase 2". Under
ruling A the limiter runs *before* your guard, so **`principalId` is still unset when the limiter
reads it, and `generalSession`'s per-principal limit remains unresolvable.** Do not paper over this.
Do not move the guard to fix it. **Record it**: state it in your report, and leave the existing
`unresolvedWarned` path to make it visible at runtime, which is what it was built for. Splitting the
limiter into an early per-IP stage and a late per-principal stage is the real fix and it is not this
task's.

So: **`abuse-prevention.md` gets no banner change from you.** If you find one sentence in it that
your work makes stale, change that sentence only, and say in your report which one and why.

**Ruling C — extend the boot assertion to three arms; do not relax it.** `AccessDeclaration` becomes
three arms and a route declaring *nothing* must still refuse startup. The existing test proves the
crash for two arms — **it must not silently start passing for three.** Add the third-arm case
alongside it. `security/authorization.md` §5 already documents `@AuthenticatedOnly()` as though it
exists; this task makes that sentence true.

**Ruling D — construct the `Principal`, never parse one.** Carry-forward ruling 16.
`packages/contracts/src/principal.ts` deliberately publishes no Zod schema, because
`principalSchema.parse(req.body)` would mint a principal out of attacker-controlled JSON. Build
`UserPrincipal` from what `SessionService.resolve` returned and from nothing else. `ApiKeyPrincipal`
stays unimplemented — `assertUserPrincipal` throws where it is reached, and that is correct.

**Ruling E — `TenantContext` is not yours.** Carry-forward ruling 12: the name exists in two
packages and Task 12 owns reconciling them. Authentication establishes *identity only*
(`security/authentication.md` §1). Do not resolve an organisation, do not read a membership, do not
attach permissions. A guard that quietly starts doing tenant resolution is how the two stages stop
being separable, and organisation switching depends on their being separate.

**Ruling F — `request.organizationId` is a rate-limiter field, not your output.** The limiter's
`perOrganization` scope reads it. Attaching it would make `generalSession` and the organisation
classes start resolving through a stage that has not been reviewed for it. Leave it alone; Task 12
owns it.

**Ruling 49 binds your tests** (Task 6): an equality assertion between two values both derived from
`Date.now()` in the same test asserts scheduling, not behaviour. Pin one side to a fixed instant.
Session expiry is exactly this shape and you will be testing it again here.

**Ruling 52 binds your guard's honesty**: revocation has one residual — Redis unreachable at the
moment of revocation leaves a row revoked and its cache entry un-poisoned for up to
`SESSION_CACHE_TTL_SECONDS`. Your guard **cannot detect this and must not pretend to**. Do not add a
"verify against Postgres anyway" path that quietly defeats the cache; if you think one is warranted,
report it as a proposal rather than shipping it.

## What you must not do

- **No endpoint.** Four routes at the end, and `auth.module.spec.ts`'s "registers no controller"
  test still passes.
- **No change to `SessionService`'s public behaviour** without saying so loudly in your report. You
  wrote it, which makes it easy to adjust rather than adapt to. If the guard wants something the
  service does not offer, that is a finding worth stating, not a quiet edit.
- **No `any`**, no `console`, and never log a raw token, a cookie header, or a CSRF token.

## Doc ownership — this task carries the most in the phase

- **`.claude/security/authentication.md` §4** — CSRF. Currently four sentences describing a design;
  it must describe what exists, name the `__Host-csrf` cookie, and keep its "Lax is the baseline,
  not the control" framing, which ADR-0017's Consequences section now depends on.
- **`.claude/api/authentication.md` §3** — the wire contract for CSRF: header name, cookie name,
  which methods, which credentials are exempt, the code and status.
- **`.claude/architecture/backend.md` §3** — the pipeline table. Three rows move: Authenticate and
  CSRF from "Not Implemented (Phase 2)"; the Authorize row's guard stays Not Implemented (Task 12)
  and must not be quietly upgraded because a *third* declaration now exists. Say what the new
  `@AuthenticatedOnly()` arm means for the boot assertion.
- **`.claude/security/authorization.md` §5** — only if what you build makes a sentence there false.
  §5 already names `@AuthenticatedOnly()`; check whether anything else in it now overstates.
- **`.claude/development/setup.md`** — only if you add an environment variable.
- **`.claude/security/abuse-prevention.md`** — see ruling B. Probably nothing.

Every one of these is subject to the honesty rule: name what is built, and name what is not. Task
6's §3 rewrite is the model — it spends as many words on "nothing calls any of it" as on the
mechanism.

## Prose rules — review-blocking

Unchanged from Task 6, and they caught four citation defects there. **You report commands and exit
codes; you do not write status prose.** No `roadmap.md` edits. Every factual claim carries the
command or the file and line that establishes it. Do not cite a document section you have not
opened, do not state a number you did not measure, and remember that a comment explaining *why* is
held to the same standard as the code — a decision can be right while the reason written beside it
is false.

## Verify

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`, `docker compose ps` — each with its real exit code, captured outside a pipe.

Plus the one the plan names explicitly: **a boot of the app proving the access assertion still
crashes on an undeclared route**, now that there are three arms. Report the command and its output.

Baseline on `feat/phase-2-task-06` at `ccc8cde`, re-verified by the orchestrator on 2026-08-26:
`pnpm test` **63 files / 917 tests**; `pnpm test:integration` **14 files / 192 tests**;
`check:specs` 77 spec files; `check:openapi` 4 routes; `check:secrets` 332 tracked files.

`pnpm test:e2e` is not expected — this task touches no `apps/web` path. If you touch one, it becomes
required and you say why you touched it.

Commit frequently with conventional-commit messages. Do not commit to `main`, do not open a pull
request, and write your report to `docs/superpowers/ledger/phase-2/task-07/report.md`.
