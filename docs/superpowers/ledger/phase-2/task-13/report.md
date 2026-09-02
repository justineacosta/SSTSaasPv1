# Task 13 implementer's report — Organisations and organisation switching

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by the implementer on 2026-09-02. Branch `feat/phase-2-task-13-organizations`, cut from
`main` at `1310604`. Commits `1da2fe9` → `e503ad7`.

**Transcribed by the orchestrator.** The implementer's harness refused to write a file at this
path, so it returned the report as its final message and the orchestrator committed it verbatim.
The wording below is the implementer's own; §11 is the orchestrator's and is marked as such.

No status prose. Every figure is a command that was run and whose output was read.

## 0. Read these three first

1. **Two of the brief's §4 decisions are false as written** — D2 and D5 (§5.1, §5.2). Neither was
   routed around silently; both replacements are measured.
2. **`ORGANIZATION_DELETED` cannot exist as an `AuditEvent`, in either write order** (§5.3). The
   brief's §6 "audit events ... for deletion" is unsatisfiable. Needs a ruling.
3. **`roadmap.md` lines 17, 81, 622** still say "no shipped route declares `@RequirePermission()`".
   Untouched — protocol §3.

## 1. Commands, exit codes, figures

All exit codes captured outside a pipe. Final run on `e503ad7`:

| Command | Exit | Figures | Baseline |
|---|---|---|---|
| `pnpm format:check` | 0 | all files clean | 0 |
| `pnpm lint` | 0 | 14/14 tasks | 0 |
| `pnpm typecheck` | 0 | 14/14 tasks | 0 |
| `pnpm test` | 0 | **95 files / 1626 tests** | 91 / 1556 |
| `pnpm check:specs` | 0 | **120 spec files** | 113 |
| `pnpm test:integration` | 0 | **25 files / 440 tests**, 229.92s | 22 / 385 |
| `pnpm build` | 0 | 8/8 tasks | 0 |
| `pnpm check:openapi` | 0 | **21 paths / 24 operations**, byte-identical | 18 |
| `pnpm check:registry` | 0 | **15 models** | 15 |
| `pnpm check:secrets` | 0 | **433 tracked files** | 416 |
| `docker compose ps` | 0 | all four `Up (healthy)` | — |

`pnpm test:e2e` **has no row because it was not run** — `git diff --stat 1310604..HEAD -- apps/web`
is empty.

**The route count: the brief predicted 24, the command prints 21.** `check-openapi-diff.ts` logs
`Object.keys(document.paths).length` — unique *paths*. Before Task 13 the two were equal.
`/api/v1/organizations` now carries 2 operations and `/api/v1/organizations/{id}` carries 3.
Counted from the artefact: `unique paths: 21  operations: 24`. The 24 are there; nothing was
changed to make a number match a sentence.

## 2. The migration, and whether it is applied

`packages/db/prisma/migrations/20260902083622_organization_lookup_function/migration.sql` — created
with `--create-only`, hand-written, 134 lines (89 of comment).

**It has been applied, after operator review**: `pnpm db:migrate` → EXIT=0,
`Applying migration 20260902083622_organization_lookup_function`. `pnpm db:reset` was never run; no
consent string fabricated.

```
 migration_name                              | applied
---------------------------------------------+---------
 20260902083622_organization_lookup_function | t

      proname       | prosecdef |        owner        |      proconfig       | app_exec | public_exec
--------------------+-----------+---------------------+----------------------+----------+-------------
 user_organizations | t         | sentinel_org_lookup | {search_path=public} | t        | f
```

Executable SQL: the `DO $$ ... RAISE EXCEPTION ... ERRCODE = 'undefined_object'` guard;
`CREATE FUNCTION public.user_organizations(p_user_id text) RETURNS TABLE (...) LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = public`; `COMMENT ON FUNCTION`;
`ALTER FUNCTION ... OWNER TO sentinel_org_lookup`; `GRANT USAGE ON SCHEMA public`;
`GRANT SELECT ON TABLE "Membership", "Organization"`; `REVOKE EXECUTE ... FROM PUBLIC`;
`GRANT EXECUTE ... TO sentinel_app`.

## 3. Measurements against the real database

**3.1 — ADR-0020's sketch is missing two grants.** Created exactly as the ADR writes it, called as
`sentinel_app`:

```
ERROR:  relation "Membership" does not exist
-- after GRANT USAGE ON SCHEMA public:
ERROR:  permission denied for table Membership
-- after GRANT SELECT ON "Membership","Organization": 2 rows
```

The first error is the more dangerous — it names a missing table, not a missing privilege.

**3.2 — ADR-0020 reproduced.** Naive read as `sentinel_app`: `(0 rows)`. Owner `NOBYPASSRLS`:
`(0 rows)`. Restored: `count 2`. After the migration, `sentinel_app`'s direct cross-org read is
still `(0 rows)`; `public_exec = f`, `app_exec = t`.

**3.3 — D2's premise holds at layer 2.** One transaction, `app.organization_id` set to an id that
did not yet exist: three `INSERT 0 1`, `orgs|memberships|audit_events = 1|1|1`, `COMMIT`, row read
back.

**3.4 — D5, four cases.** Audit-then-delete: `Key is still referenced from table "AuditEvent"`.
Delete-then-audit: `Key is not present in table "Organization"`. Delete with no audit row:
`DELETE 1, COMMIT`. Delete an org with history: FK violation.

**3.5 — the compose database had drifted, and it hid a control.**
`has_table_privilege('sentinel_app','Organization','DELETE')` was `t` locally and `f` on a replayed
database. Phase 1's `REVOKE DELETE ON "Organization" FROM sentinel_app` exists precisely so
request-path code cannot delete a tenant — and nothing asserted it. That is why a local probe
returned the FK error and looked complete while Testcontainers answered 500. Now asserted both
directions in `migration.integration.spec.ts`. I realigned compose by running the `REVOKE`; nothing
else was changed there.

**3.6 — the two error shapes.** Duplicate slug via `$executeRaw`: `P2010`, `meta.code 23505`.
Privilege denial via `tx.organization.delete(...)`: `PrismaClientUnknownRequestError`, **no code, no
meta**. Same denial via raw SQL: `P2010`, `meta.code 42501`.

## 4. Mutations

M1 and M5 re-run at `e503ad7` so all counts describe the final tree.

| # | Mutation | Red | Survivors |
|---|---|---|---|
| M1 | delete `assertPathIsActiveTenant` from `read()` | **3 of 30** | matrix green — its arm 3 moves the session, so the path id still matches |
| M2 | `@RequirePermission('organization.update')` → `@AuthenticatedOnly()` | 1 unit + 1 integration | **the matrix stayed green** |
| M3 | delete `@RequireVerifiedEmail()` | 1 unit + 1 integration | — |
| M4 | replace `user_organizations()` with the naive read | **5 of 18** | 5 pagination/validation tests asserting emptiness — fail-closed |
| M5 | drop `withTenantTransaction` from `read()` | **3 of 30** incl. matrix arm 4 | — |
| M6 | `switch-org` admits any org id | **5 of 14** | the 9 asserting a successful switch |

**The M2 survivor matters.** The matrix cannot detect one guarded route being downgraded — it simply
leaves the guarded set. The replaced sentinel catches the set going *fully* empty. What caught it:
`organizations.controller.spec.ts`'s access table and the scoped spec's 403 arm.

Five further mutations against the migration, before commit: drop SELECT grant (1 red), owner
without `BYPASSRLS` (2), drop `SET search_path` (1), drop `REVOKE ... FROM PUBLIC` (1), drop the
`deletedAt`/`status` predicate (1).

## 5. What the brief got wrong

**5.1 — D2 is false.** Layer 2 accepts it; **layer 1 refuses it**. `tenant-scope.ts` puts `create`
in `ROOT_DISALLOWED_OPERATIONS` — *"organisation creation runs through the unscoped client during
onboarding"* — and `tenant-scope.spec.ts:36` pins that refusal. Measured:
`MissingTenantContextError: No organisation in context for Organization.create`. At the endpoint, a
500. **Shape shipped:** still `withTenantTransaction` on the new id; the root row inserted with
parameterised `$executeRaw` and read back through `findUniqueOrThrow`; the two tenant-owned inserts
still through the extension. Layer 1 live for `Membership`/`AuditEvent`, layer 2 live for all three.
**This differs from what D2 names — please rule on it.**

**5.2 — D5 names the second reason.** The first is the revoked `DELETE` privilege (§3.5), which
fires for an org with no history too. The endpoint answers 409 for both and issues the statement
rather than short-circuiting, so it starts working when Phase 11 grants the privilege and never
before. Neither constraint nor privilege weakened.

**5.3 — `ORGANIZATION_DELETED` cannot be written.** Both orders fail. Since creation audits itself,
**no organisation created through this API can ever be deleted**. The name is absent from
`AUDIT_ACTIONS` with the transcript beside it; it stays in `audit.md` §4's taxonomy for Phase 11. A
`PlatformAuditEvent` was considered and not taken — ADR-0019 routes on the presence of an
organisation, and reversing that is not an implementer's call. **Needs a ruling.**

**5.4 — the matrix's CSRF gap was real.** `PATCH`/`DELETE` passed arm 2 with authorization never
having run. Closed twice: derived CSRF header, and arms 2/3 now assert the error **code**.
Separately, the matrix requested `:id` literally → 404, the fail-closed direction, so arms 1–3 would
have passed testing nothing. Now substitutes path parameters; an unknown parameter is a hard
failure.

**5.5 —** the route-count prediction (§1).

## 6. Decisions the brief did not make

1. `switch-org` → **403 `ORGANIZATION_SUSPENDED`** for a suspended org the caller belongs to (the
   code matches what guarded routes answer afterwards).
2. `switch-org` returns **200, not 201** — found by the spec (`expected 201 to be 200`).
3. **The `:id` routes are MFA-gated without exception** — the decision `require-mfa.spec.ts`'s H-1
   demanded. Nothing carries `@AllowWithoutMfaEnrolment()`; every route such a member needs is
   `@AuthenticatedOnly()`. `MFA_ENROLMENT_REQUIRED` has a reachable producer for the first time,
   proved both directions.
4. The `switch-org` audit row is written **after** the rotation — `logout.service.ts`'s compromise,
   same reason.
5. All five routes carry `generalSession` — `abuse-prevention.md` §1 has no org row.
6. The **OpenAPI generator now emits `{id}` and a `parameters` array** — the first path-parameter
   route in the product.
7. `POST /organizations` → **201 with no `Location`** (it would 404 for this caller until they
   switch).
8. **`AuthModule` imports `RolesModule` explicitly** rather than relying on `@Global()` — found by
   `auth.module.spec.ts`.
9. `principalOf` moved to `request-context.ts`.

## 7. The Task 12 sentinels

All three went red as designed. The matrix sentinel → inverted (at least one guarded route must
exist). `email-verified.guard.spec.ts` → an assertion **naming** the file, not counting; its
`toHaveLength(3)` controller pin also fired at 4. `require-mfa.spec.ts` → the decision in §6.3 plus
an exemption assertion. `auth.controller.spec.ts`'s exhaustiveness test found `switchOrganization`
before a row existed: `expected [ 'changePassword', …(14) ] to deeply equal [ …(13) ]`.

## 8. Files

**New:** the whole `apps/api/src/modules/organizations/` (11 files),
`modules/audit/{audit.actions,audit.service,audit.service.spec}.ts`,
`modules/auth/{organization-switch.service.ts,auth.switch-org.integration.spec.ts}`, the migration.

**Changed:** `app.module.ts` + spec, `authorization-matrix.integration.spec.ts`,
`email-verified.guard.spec.ts`, `audit.module.ts`, `auth.controller.ts` + spec, `auth.module.ts`,
`request-context.ts`, `require-mfa.spec.ts`, `openapi/generate.ts` + integration spec,
`openapi.json`, `migration.integration.spec.ts`, `01-app-role.sql`, six `.claude/` documents.

Diffstat vs `1310604`: **42 files, +6136 / −170**.

## 9. Documentation

`api/authentication.md` (switch-org behaviour; route count removed from the banner — three tasks
failed to update it), `api/authorization.md` and `security/authorization.md` (the "no shipped
endpoint declares a permission" sentences, plus the inapplicable-403 arm on `organization.read`),
`security/tenant-isolation.md` (new "The one deliberate exception — ADR-0020" + residual-risk
entry), `security/audit.md` (`ORGANIZATION_SWITCHED`), `development/setup.md` and
`operations/deployment.md` (both roles as preconditions, with SQL and recovery).

**Not touched:** `roadmap.md`, ADR-0020.

## 10. Left undone, plainly

1. **The brief's §6 "audit event in the same transaction as the deletion" is not implemented and
   cannot be.** Needs a ruling.
2. **`roadmap.md` lines 17, 81, 622** still carry the now-false sentence.
3. **`org_probe_d2` remains in the compose database** with an `AuditEvent` referencing it —
   undeletable (append-only trigger, then `Restrict`). Local dev data; reaches no Testcontainers
   run. Every other probe row I created was cleaned up in the same step.
4. **Compose's `DELETE` privilege was realigned by hand.** If other privileges have drifted the same
   way, nothing has looked.
5. **`pnpm test:e2e` not run** — no `apps/web` path touched.
6. **CI has not run on this branch; nothing pushed.**
7. **The M2 survivor** is recorded, not fixed.
8. **`meta.total` is never returned** by `GET /organizations` — counts are opt-in per
   `pagination.md` §3 and the query schema has no such field.
9. **No reviewer has seen any of this.** Every figure above is the author checking their own work.

## 11. Orchestrator's verification and rulings — 2026-09-02

**This section is the orchestrator's, not the implementer's.**

### 11.1 Every figure in §1 was independently re-run on `e503ad7`

Not taken from the report. Exit codes captured outside a pipe, on the finished tree:

| Command | Exit | Figure re-measured |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 14 tasks |
| `pnpm typecheck` | 0 | 14 tasks |
| `pnpm build` | 0 | 8 tasks |
| `pnpm test` | 0 | **95 files / 1626 tests** — matches |
| `pnpm check:specs` | 0 | **120 spec files** — matches |
| `pnpm test:integration` | 0 | **25 files / 440 tests** — matches |
| `pnpm check:openapi` | 0 | byte-identical, logs **21** — matches |
| `pnpm check:registry` | 0 | **15 models** — matches |
| `pnpm check:secrets` | 0 | **433 tracked files** — matches |

**The paths-versus-operations correction in §1 is confirmed and the brief was wrong, not the
implementation.** Counted directly from `apps/api/openapi.json`: `unique paths: 21  operations: 24`,
with the five organisation operations across two paths. The brief's "must report 24" instructed the
implementer to make a command print a number it does not print; it correctly refused.

**§5.1 is confirmed against the source, not accepted on assertion.** `create` is in
`ROOT_DISALLOWED_OPERATIONS` at `packages/db/src/tenant-scope.ts:57-62`, and
`tenant-scope.ts:233` refuses it for the root model. Brief decision D2 was false as written.

### 11.2 Ruling — D2's replacement shape is accepted

The shipped shape stands: `withTenantTransaction` on the new organisation's id, the root row
inserted with parameterised `$executeRaw` and read back through `findUniqueOrThrow`, the two
tenant-owned inserts through the extension. Layer 2 is live for all three rows; layer 1 is live for
the two it can express. This is the most that can be true given that layer 1 deliberately refuses
`create` on the tenant root, and the alternative — reaching for the unscoped client for the whole
transaction — would have dropped layer 1 for `Membership` and `AuditEvent` as well.

**The cost if this is wrong:** the one `INSERT` that layer 1 does not police is the tenant root's
own creation, where the id is generated by this application in the same function. A raw insert is
not automatically scoped, so a future edit that lets a caller influence that statement's columns
would not be caught by the extension. It is a parameterised statement over a locally generated id
today; the reviewer should confirm that and say so.

### 11.3 Ruling — `ORGANIZATION_DELETED` stays absent, and the brief's §6 bullet was overreach

The implementer is right and my brief was wrong. `AuditEvent.organizationId` is `onDelete:
Restrict`, so a deletion and an event describing it cannot commit together in either order — both
directions measured. The plan's own words for Task 13 are *"deletion fails while audit events exist,
by design"* and *"Do not weaken the constraint"*, which the 409 satisfies exactly. My brief's §6
then asked for an audit event on deletion, which contradicts the plan it was drawn from. **The brief
was wrong; no code changes.**

`ORGANIZATION_DELETED` stays in `security/audit.md` §4's taxonomy as a name Phase 11's purge path
will write, and stays out of `AUDIT_ACTIONS`, where a producer no transaction can commit would be
worse than an absence.

Routing it to `PlatformAuditEvent` was correctly not taken: ADR-0019's rule is the presence of an
organisation, and a deletion has one right up until it does not.

### 11.4 A false sentence in `security/audit.md`, found by the orchestrator and fixed

`audit.md` asserted *"The four names an `AuditEvent` row may carry today are `ORGANIZATION_CREATED`,
`ORGANIZATION_UPDATED`, `ORGANIZATION_DELETED` and `ORGANIZATION_SWITCHED`"* and cited
`audit.actions.ts`. That file holds **three** names and excludes `ORGANIZATION_DELETED` — extracted
mechanically from `AUDIT_ACTIONS` rather than read by eye:

```
count: 3
ORGANIZATION_CREATED
ORGANIZATION_UPDATED
ORGANIZATION_SWITCHED
```

So the document contradicted the file it cited, in the same change whose code comment explains at
length why that name cannot have a producer. Corrected to three, with the reason and the measured
transcripts, in the same commit as this report.

**This is the phase's signature defect, in its purest form yet** — a false claim in prose,
introduced *while* correctly documenting the thing it got wrong, citing the artefact that disproves
it. Every previous instance took a reviewer to find. This one was found by extracting the list
instead of reading it, which is the cheap general defence: **when a document states a count, compute
the count.**

### 11.5 What the orchestrator has not done

No fix was applied to the M2 survivor (§4). Nothing has been pushed and CI has not run. The
adversarial review has not happened, and until it does every claim here — including this section —
is the work of the two parties that produced it.
