# Task 13 brief — Organisations and organisation switching

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the orchestrator on 2026-09-02, before any code. Branch
`feat/phase-2-task-13-organizations`, cut from `main` at `1310604`.

Plan section: [`Task 13`](../../../plans/2026-08-24-phase-2-identity.md) — "Organisations and
organisation switching". Execution mode: implementer subagent, fresh adversarial reviewer after.
**Task 13 only.** The plan groups 13→15 as a chain; the operator paces one task per session, and
Tasks 14 and 15 are not in this run.

## 1. Why this task matters more than its endpoint count suggests

Task 12 built the whole authorization pipeline — nine global guards, six ordered layers, each able
to deny — and **not one of them has ever run against a real request.** Carry-forward ruling 93 is
the reason: `TenantContextGuard` short-circuits before its query when
`Session.activeOrganizationId` is null, and nothing in this codebase writes that column.

Task 13 is the task that writes it. On the day `POST /auth/switch-org` lands, tenant resolution,
the MFA-enrolment gate, the organisation-status check and the permission check all begin executing
on production traffic for the first time. **And this is the first task in the phase to ship a route
carrying `@RequirePermission()`** — until now every one of the eighteen shipped routes is
`@Public()` or `@AuthenticatedOnly()`, so layers 2–4 govern zero endpoints.

Two consequences for how you work:

- A bug in Task 12 that no test caught surfaces *here*, as a 404 or a 403 on a route that should
  work. Do not assume the pipeline is right because it is tested; if a guard denies something it
  should not, measure before working around it, and report it rather than routing past it.
- **An empty permission set in a captured response is not evidence that resolution ran** (ruling
  93, in as many words). Your evidence for "the pipeline executes" must be a response that could
  only have come from a resolved tenant — a populated `permissions` array, a 403 from
  `AuthorizationGuard` naming the permission, a cross-tenant 404.

## 2. What to build

Five endpoints. All under `/api/v1`, all in a new `apps/api/src/modules/organizations/` module,
following the shapes `apps/api/src/modules/auth/` already established.

| Route | Access declaration | Notes |
|---|---|---|
| `POST /organizations` | `@AuthenticatedOnly()` + verified-email gate | Creates org + creator's `OWNER` membership + audit event **in one transaction** |
| `GET /organizations` | `@AuthenticatedOnly()` | The caller's own organisations. Paginated. ADR-0020 governs the read |
| `GET /organizations/:id` | `@RequirePermission('organization.read')` | |
| `PATCH /organizations/:id` | `@RequirePermission('organization.update')` | |
| `DELETE /organizations/:id` | `@RequirePermission('organization.delete')` | 409 while audit events exist — see §4 |
| `POST /auth/switch-org` | `@AuthenticatedOnly()` | Rotates the session, writes `activeOrganizationId` |

`POST /auth/switch-org` belongs to `AuthController` — it is an authentication-context change, it is
what `api/authentication.md` §2 already documents, and `switchOrganizationRequestSchema` /
`switchOrganizationResponseSchema` already exist in `packages/contracts/src/auth.ts:269-278`. Do not
create a second controller for it.

### Contracts already exist. Do not rewrite them.

`packages/contracts/src/organizations.ts` ships every schema this task needs:
`createOrganizationRequestSchema`, `updateOrganizationRequestSchema`, `organizationResponseSchema`,
`listOrganizationsQuerySchema`, `organizationCollectionSchema`. Read that file first — its docblocks
record decisions you must not silently reverse.

**Carry-forward ruling 15 binds you if you touch the update schema:**
`updateOrganizationRequestSchema` is a `ZodEffects` because of its `.refine()`, so `.extend()`,
`.partial()` and `.merge()` do not exist on it. **You should not need to touch it.** Phase 2 patches
the name and nothing else; `requireMfa` and `enforcedEmailDomain` stay out, for the reason the
docblock gives — a security setting a customer can switch on while no code reads it is worse than
one that is not offered. If you conclude otherwise, stop and report rather than rebuilding the
schema.

## 3. The cross-organisation read — ADR-0020, already decided and measured

`GET /organizations` is the one query in this task that spans organisations, and the naive
implementation returns **zero rows for every user who has organisations**. `Membership` carries
`FORCE ROW LEVEL SECURITY` keyed on `app.organization_id`; the API connects as `sentinel_app`, which
has no `BYPASSRLS`. This was measured on 2026-09-02 against the compose Postgres and the transcript
is in [ADR-0020](../../../../.claude/decisions/ADR-0020-cross-organisation-membership-lookup.md).

**Implement exactly what ADR-0020 decides.** A migration creates one `SECURITY DEFINER` function,
`user_organizations(p_user_id text)`, owned by a new `NOLOGIN NOINHERIT BYPASSRLS` role
`sentinel_org_lookup`, with `SET search_path = public`, `REVOKE EXECUTE ... FROM PUBLIC` and
`GRANT EXECUTE ... TO sentinel_app`. The ADR contains the shape; the exact column list and return
type are yours.

Three things the ADR requires that are easy to skip:

- **`sentinel_org_lookup` must be added to `infra/docker/postgres/init/01-app-role.sql`**, next to
  `sentinel_app`, guarded by the same `IF NOT EXISTS` pattern. Creating a `BYPASSRLS` role needs
  superuser, so the migration cannot create it — it must pre-exist, exactly as `sentinel_app` does
  (ruling 96). A migration that assumes the role exists must fail loudly and legibly if it does not.
- **The migration integration spec must assert the role's attributes** — `rolbypassrls = true`,
  `rolcanlogin = false` — and the function's grants. Without those assertions the ADR's entire
  containment argument rests on a role attribute nothing checks. This is named in the ADR's
  consequences as a requirement, not a suggestion.
- **`SET search_path = public` is load-bearing**, not decoration. It closes the standard
  `SECURITY DEFINER` hijack.

`userId` comes from the authenticated session (`request.principal`), never from a path parameter,
query string or body. Ruling 9's rule for user-owned reads.

## 4. Decisions already taken. Implement these; do not re-litigate them.

**D1 — `POST /organizations` is `@AuthenticatedOnly()`, not permission-guarded.** There is no
organisation to hold a permission in yet. It is gated on a **verified email** instead, per the plan.
`EmailVerifiedGuard` and `@RequireVerifiedEmail()` exist from Task 8 and, per the Task 12 pause
state, **no handler carries the decorator today** — this route is the first. That means you are
switching on an opt-in control that has never fired in production; prove it fires, and prove an
unverified caller is refused.

**D2 — Creation runs inside `withTenantTransaction` scoped to the new organisation's id.** Generate
the id first, then open the transaction on it. `Organization`'s policy is keyed on `id` with a
`WITH CHECK`, and `Membership`/`AuditEvent` are keyed on `organizationId`, so all three inserts
satisfy their policies inside that one transaction. **This is a hypothesis, not a fact — measure
it.** If it does not hold, report what you measured before choosing a different shape.

**D3 — Slug uniqueness is the database constraint first.** `Organization.slug` is `@unique`. Catch
P2002 and answer 409; do not pre-check with a `findUnique` and treat that as the guard. A read
followed by a write is a race, and `CLAUDE.md`'s "database integrity belongs in the database" rule
says which one is the first line. A pre-check as a *nicety* is fine only if the constraint is still
the thing that decides.

**D4 — `:id` must equal the resolved tenant, and a mismatch is 404.** `TenantContextGuard` resolves
the organisation from `Session.activeOrganizationId`, not from the URL. So `GET /organizations/:id`
for an organisation the caller is not currently acting in is **404, not 403** — the same rule the
plan states for switch-org and the same rule `security/tenant-isolation.md` states generally.
Do not resolve the tenant from the path; that would route around Task 12's entire pipeline. Assert
the path id against the resolved context and 404 on any difference, including an id that does not
exist and an id belonging to an organisation the caller *does* belong to but is not active in.

**D5 — `DELETE` answers 409 while audit events exist, and the constraint is not weakened.**
`AuditEvent.organizationId` has `onDelete: Restrict`. Catch the foreign-key violation and return
409 with a message that says why — deletion is refused while the organisation has an audit history,
and the real purge path is Phase 11's platform admin. **Do not change the foreign key. Do not
soft-delete as a workaround** unless you report it first; `Organization` has no `deletedAt` and
adding one is a schema decision outside this task.

**D6 — `switch-org` rotates the session.** `SessionService.rotate` exists
(`apps/api/src/modules/auth/session.service.ts:600`). Switching to an organisation the caller is not
an active member of is **404**. The response is `sessionResponseSchema` — the same document
`GET /auth/session` returns — and after a successful switch its `permissions` array must be
populated, which is the first time in this phase that array is non-empty.

**D7 — There is no permission cache and you must not add one.** Ruling 94, an operator decision of
2026-09-02. `tenantResolver` reads `Membership.roleId` and the seeded grants fresh on every request
that names an organisation. Do not add caching to make switch-org feel faster.

## 5. Rulings that bite in this task

Read these before writing code. Full text in [`../progress.md`](../progress.md).

- **9** — the four user-owned tables have no RLS. A handler taking a `userId` must prove the caller
  is that user. Binds §3's function call.
- **10** — a `Membership` write must set `status` and `deletedAt` together; the CHECK constraint
  makes `REMOVED` and soft-deleted the same fact. You write an `ACTIVE` membership, so set
  `deletedAt: null` explicitly rather than relying on a default.
- **15** — `updateOrganizationRequestSchema` is a `ZodEffects`. See §2.
- **93** — an empty permission set is not evidence that resolution ran. See §1.
- **99** — `(organizationId, userId)` is unique only `WHERE "deletedAt" IS NULL`. Every
  `Membership` read you write must carry `deletedAt: null`, or it may return a `REMOVED` row
  non-deterministically. Measured, on a replayed schema.
- **100** — a regression test for a non-deterministic read has to be **arranged to lose**. If you
  test ruling 99's case, insert the removed rows so the live one comes back *last*, or the test
  passes under the mutation by luck.
- **14** — `UNKNOWN_FIELD` at 400 when every Zod issue is an unrecognised key; mixed failures stay
  `VALIDATION_ERROR`. Binds every new endpoint.
- **103** — `toContain` over a module's source text is satisfied by the import line. Assert module
  registration against `Reflect.getMetadata('providers', AppModule)`, and remember that
  `indexOf(A) < indexOf(B)` is vacuously true when A is absent.
- **1** — each migration must leave the database sound on its own.

## 6. Testing — where this can actually fail

`CLAUDE.md`'s testing rule, and the parts of it that are not optional here.

- **Cross-tenant isolation tests are mandatory.** `Organization` is the tenant root and `Membership`
  is tenant-owned. Tenant A must receive **404** for Tenant B's ids on `GET`, `PATCH` and `DELETE`,
  and on `switch-org`. Not 403.
- **The authorization matrix must cover the new routes.** It runs over the live route inventory and
  fails on any route it did not exercise, per ruling 101 — and it now records coverage per
  (route, arm). Three of these routes carry a permission, so the 403 and cross-tenant-404 arms run
  over a **production endpoint for the first time**. Ruling 101 notes the matrix's sentinel "names
  what must replace it instead of only asserting an empty set" — that day has arrived, and the
  sentinel asserting no route declares a permission must now be updated rather than deleted.
- **Integration, not mocks, for anything involving RLS.** Note carry-forward ruling 58: the
  integration harness binds the app to the schema-owner DSN, so **RLS cannot bite in the default
  harness**. `active-organization.store.ts` records the fix — a second client bound to the harness's
  `appUrl`, which is `sentinel_app`. Any test that claims to prove an RLS behaviour must drive the
  `sentinel_app` client, or it proves nothing. This applies directly to §3's function.
- **Pagination.** `GET /organizations` uses `listQuerySchema`, defaults 50, max 100, clamps rather
  than rejects, and **echoes the applied limit** in `pagination.limit`. The clamp and the echo are
  one feature.
- **Audit events in the same transaction as the change** — creation, update, deletion, and the
  organisation switch. These have an organisation in hand, so they are `AuditEvent` rows, not
  `PlatformAuditEvent` (ADR-0019's routing rule is the presence of an organisation).
- **Mutation-test your security claims.** Every claim of the form "X is refused" must be backed by a
  mutation you actually ran and watched go red, with the counts pasted. Ruling 97: when reporting a
  mutation result, list the survivors. A test that stays green under the mutation is a test that
  proves nothing, and this phase has found five of those by looking.

## 7. Documentation you own

Per the execution protocol §6, these ship in the same task, not at the end:

- `.claude/api/authentication.md` — `switch-org`'s real behaviour.
- `.claude/api/authorization.md` and `.claude/security/authorization.md` — the sentence that no
  shipped route declares a permission becomes false the moment this lands. Find it and fix it.
- `.claude/security/tenant-isolation.md` — ADR-0020's function is a new, deliberate exception to
  the two-layer property this document describes. It must say so.
- `.claude/development/setup.md` and any deployment/runbook document naming `sentinel_app` — a
  second role must now pre-exist.
- **You do not write status prose.** Execution protocol §3: implementers report commands and exit
  codes. No `roadmap.md` edits, no "this now works", no summary paragraphs. The orchestrator writes
  every sentence that asserts anything. Documentation of *behaviour* is yours; assertions about
  *state* are not.

## 8. Verification

Run all of these and capture the **real exit code outside a pipe** —
`out=$(pnpm <cmd> 2>&1); code=$?` — because `$?` after a pipe reports the last stage's status:

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm check:specs`,
`pnpm test:integration`, `pnpm build`, `pnpm check:openapi`, `pnpm check:registry`,
`pnpm check:secrets`, `docker compose ps`.

`pnpm check:openapi` reports **18** routes at `1310604`. It must report **24** when you are done,
and `apps/api/openapi.json` must be regenerated and committed. `pnpm check:registry` reports 15
models; this task adds no table, so it must still report 15 — a change there means you added a model
you did not mean to.

`pnpm test:e2e` — Task 13 touches no `apps/web` path. If that stays true, it has no row and you say
so. Do not add a row for a command you did not run.

**Migrations:** use `prisma migrate dev --create-only`, stop, and report the SQL. The operator reads
every migration before it is applied (execution protocol §5), and **ruling 3 says you cannot run
`pnpm db:reset`** — Prisma refuses it for an AI agent and requires a consent string you must never
fabricate. House style: lead with the reasoning, then the SQL.

## 9. What to report

Commands, exit codes, file paths, and measurements. For each security claim, the mutation you ran
and what it did. For §3 and D2, the transcript of what you measured against the real database, not
a description of it. If something in this brief turns out to be wrong — that has happened in this
phase repeatedly, including in briefs — **say so with the measurement that shows it**, and stop
rather than routing around it.
