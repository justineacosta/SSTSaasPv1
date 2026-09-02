# Task 13 adversarial review — Organisations and organisation switching

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Written by an adversarial reviewer on 2026-09-02, who wrote none of this code. Range
`1310604..HEAD` at `6e8ba1b`. Nothing was committed, fixed or pushed. Every mutation applied below
was reverted; `git status --short` is empty at the time of writing.

Environment: Docker Desktop up, compose stack healthy, ADR-0020 migration applied, Postgres 16.14.

---

## Part 1 — The citation pass

Forty-one claims checked before any diff was opened. **Thirty-four held. Seven are false.** The
false ones are listed first, then everything that held, because "seven of forty-one" is the number
that matters and a list of failures alone would not give it.

### 1.1 False claims

#### C1 — `audit.actions.ts:106` says "All four actions above" and the file holds three. **The §11.4 defect, still live, in the same file §11.4 mechanically extracted from.**

`AUDIT_ACTIONS` has three members. Derived independently of the orchestrator's method (stripping
block and line comments from the array literal and matching quoted identifiers, rather than
whatever produced §11.4's transcript — ruling 104):

```
runtime-derived count: 3
ORGANIZATION_CREATED
ORGANIZATION_UPDATED
ORGANIZATION_SWITCHED
```

`apps/api/src/modules/audit/audit.actions.ts:106`, in the `AUDIT_RESOURCE_TYPES` docblock:

> `nothing writes is a list nobody maintains. All four actions above are events`

§11.4 corrected `security/audit.md` from four to three, called this "the phase's signature defect,
in its purest form yet", and prescribed the general defence — *"when a document states a count,
compute the count."* It then did not apply that defence to the rest of the file it was reading. The
false count survives twenty-one lines below the constant it miscounts.

This is a documentation defect only; nothing reads the number.

#### C2 — The now-false permission sentence survives in **two** places the report does not disclose, not the three it does.

Report §0.3 and §10.2 disclose `roadmap.md` lines 17, 81 and 622. Those three are correct — verified
by grep, exact line numbers match. But a repo-wide sweep for every spelling of the sentence returns
five live sites:

| Site | Disclosed? |
|---|---|
| `.claude/product/roadmap.md:17` | yes |
| `.claude/product/roadmap.md:81` | yes |
| `.claude/product/roadmap.md:622` | yes |
| **`.claude/architecture/backend.md:85`** | **no** |
| **`apps/api/src/common/authorization-matrix.integration.spec.ts:390`** | **no** |

`backend.md:85` reads *"**No shipped route declares a permission**, so it governs nothing yet —
Tasks 13–15 ship the first"*. It is not in the changed set, and report §9's "Not touched" names only
`roadmap.md` and ADR-0020, so the document is not disclosed as stale anywhere.

Task 12's own `review-brief.md:54` warned that this sentence *"appears in at least seven places"*.
The warning was on file and the sweep was not run.

#### C3 — `authorization-matrix.integration.spec.ts:386-392` contradicts the test directly beneath it, in a file this task edited.

```
 * **The set is empty today** — no shipped route declares `@RequirePermission()`,
 * and `there are none yet` below states that rather than letting a green tick
 * imply coverage. But the arms are now *written*, so the day Task 13 ships a
 * guarded endpoint every one of them runs against it with no edit here.
```

Four falsehoods in one paragraph, as of this commit:

1. "The set is empty today" — it holds three routes.
2. "no shipped route declares `@RequirePermission()`" — the sentence the task exists to falsify.
3. "`there are none yet` below" — no test by that name exists; it was renamed to
   `'there is at least one, so the three arms below are not vacuous'` in this range.
4. "with no edit here" — the file took 136 insertions in this range, including that very test.

The inner comment fifteen lines below (lines 402-415) describes the new state correctly and at
length. The file states both things at once. This is a stricter instance of C1's class: the
`describe` block's docblock is the first thing a reader of this file sees.

#### C4 — ADR-0020's fourth containment property is false. `SET search_path = public` does **not** close the definer hijack. Measured.

The claim appears four times:

- `ADR-0020...md`, Decision §4: *"**`SET search_path = public`** closes the standard `SECURITY
  DEFINER` hijack, where a caller creates a shadowing object in a schema earlier on the path."*
- `20260902083622_organization_lookup_function/migration.sql:81-82` — same words.
- `.claude/security/tenant-isolation.md`, "The one deliberate exception" — same words.
- `packages/db/src/migration.integration.spec.ts:286-288` — same words, as the rationale for the
  assertion that pins the vulnerable value.

PostgreSQL searches `pg_temp` **first, ahead of everything**, for relation names whenever `pg_temp`
is not explicitly listed in `search_path`. `SET search_path = public` does not list it. The
documented safe form is to write `pg_temp` as the **last** entry.

`sentinel_app` holds `TEMPORARY` on the database (the PostgreSQL default grant to `PUBLIC`, never
revoked here):

```
 app_temp | app_connect
----------+-------------
 t        | t
```

Full hijack, as `sentinel_app`, one session, no tenant context:

```
CREATE TEMP TABLE "Membership" (id text, "organizationId" text, "userId" text,
                                status text, "deletedAt" timestamptz);
INSERT INTO pg_temp."Membership" VALUES ('fake1','org_probe_d2','usr_attacker_not_a_member','ACTIVE',NULL);
GRANT SELECT ON pg_temp."Membership" TO sentinel_org_lookup;

=== FULL HIJACK: attacker-controlled Membership, real Organization, BYPASSRLS ===
      id      |   slug   |   name   | status
--------------+----------+----------+--------
 org_probe_d2 | probe-d2 | Probe D2 | ACTIVE
(1 row)

=== control: sentinel_app cannot read Organization directly ===
 direct_org_reads: 0
=== control: sentinel_app cannot read real Membership directly ===
 direct_membership_reads: 0
```

The function returned a real `Organization` row, under the `BYPASSRLS` owner, for a user with no
membership at all — while the same role's direct reads of both tables returned zero rows.

Diagnosis proven by fix, same session, same temp table:

```
=== shipped function (search_path = public) ===
 org_probe_d2 | probe-d2      (1 row)
=== same attack vs search_path = public, pg_temp ===
 (0 rows)
```

The `GRANT SELECT ON pg_temp."Membership"` step is required and is available to the attacker,
because `sentinel_app` owns its own temp tables. Without it the hijack still resolves — the function
errors with `permission denied for table Membership`, which is itself proof that `pg_temp` won the
name resolution — but returns nothing.

Two further ADR sentences fall with it:

- *"there is no way to widen the read short of editing a migration"* — the read was widened without
  editing a migration.
- *"The predicate is fixed in the function body"* — the predicate held, but the **relations it reads
  from** are not fixed.

Reachability is the mitigating fact and it is real: this requires arbitrary SQL execution as
`sentinel_app`, which the HTTP API does not offer. See finding **H1** for the severity argument.

#### C5 — Report §2: the migration is "134 lines (89 of comment)". It is 88.

```
comment: 88   blank: 6   sql: 40   total: 134
```

Lines 1-88 are the comment block; line 89 is blank. No inline `--` appears on any SQL line, so no
counting convention reaches 89. Off by one.

#### C6 — Report §8: "six `.claude/` documents". Eight were modified; nine changed including the new ADR.

```
M .claude/api/authentication.md          M .claude/security/audit.md
M .claude/api/authorization.md           M .claude/security/authorization.md
A .claude/decisions/ADR-0020-...md       M .claude/security/tenant-isolation.md
M .claude/decisions/README.md
M .claude/development/setup.md
M .claude/operations/deployment.md
--- modified: 8   added: 1
```

§8 says six; §9 names seven of them (omitting `decisions/README.md`). The report contradicts itself
between two adjacent sections. **The review brief I was given repeats "the six `.claude/`
documents", so the count was carried forward unchecked by the orchestrator as well.**

#### C7 — Report §4's explanation of the M1 survivor is wrong, and its own measurement refutes it.

> `M1 | delete assertPathIsActiveTenant from read() | 3 of 30 | matrix green — its arm 3 moves the
> session, so the path id still matches`

Arm 3 (`authorization-matrix.integration.spec.ts:478-510`) does the opposite. It points the
stranger's session at `other.organizationId` and substitutes the path with **the stranger's own**
organisation id. The two are different organisations by construction, so the path id cannot match.
The test's own comment says so: *"The path is substituted with the STRANGER's own organisation id."*

The refutation is internal to the reported measurement. If the path id matched the session, the
mutated handler would have answered 200 and arm 3 — which expects 404 — would have gone red. It
stayed green. So the 404 arm 3 observes comes from somewhere the mutation did not touch.

The actual mechanism, from `tenant-context.ts:100-105,271-275`: the stranger holds no `Membership`
in the session's organisation, so `resolveTenant` returns `not-a-member` and `TenantContextGuard`
answers 404 **before the handler runs at all**. See finding **M3** — arm 3 is a weaker probe than
its docblock claims, and this misdescription is what hides that.

### 1.2 Claims that held

Every figure in report §1, re-derived rather than re-read:

| Claim | Result |
|---|---|
| `pnpm format:check` exit 0 | ✅ exit 0 |
| `pnpm lint` exit 0, 14/14 tasks | ✅ `Tasks: 14 successful, 14 total` |
| `pnpm typecheck` exit 0, 14/14 tasks | ✅ `Tasks: 14 successful, 14 total` |
| `pnpm test` 95 files / 1626 tests | ✅ `95 passed (95)` / `1626 passed (1626)`, exit 0 |
| `pnpm check:specs` 120 spec files | ✅ `120 spec files` |
| `pnpm check:registry` 15 models | ✅ `15 models, 3 tenant-owned, 1 tenant root, 11 global` |
| `pnpm check:secrets` 433 tracked files | ✅ `433 tracked files` |
| `pnpm check:openapi` byte-identical | ✅ exit 0, byte-identical |
| `pnpm test:integration` 25 files / 440 tests | ⚠️ counts match; **exit 1 on my run** — finding **M1** |

**The 21-paths / 24-operations correction (§1, §11.1) is true, derived a third way** (ruling 104).
Rather than reading what `check-openapi-diff.ts` logs, I parsed `apps/api/openapi.json` in Node and
counted HTTP verb keys per path:

```
unique paths: 21
operations: 24
--- organisation paths ---
1 /api/v1/auth/switch-org
2 /api/v1/organizations
3 /api/v1/organizations/{id}
```

The brief's predicted 24 was a count of operations; the command prints paths. The implementer was
right to refuse to make the number move.

Other claims verified:

| Claim | Source | Result |
|---|---|---|
| Diffstat "42 files, +6136 / −170" | report §8 | ✅ exact, for `1310604..e503ad7`, the range §8 names. `1310604..HEAD` is 43/+6473 because the report itself is in it. Correctly scoped. |
| `organizations/` is 11 files | report §8 | ✅ 11 |
| `create` is in `ROOT_DISALLOWED_OPERATIONS`, `tenant-scope.ts:57-62` and `:233` | §11.1 | ✅ present at both |
| `auth.controller.ts` now has 15 handlers ("…(14)") | report §7 | ✅ 15 route decorators |
| `roadmap.md` lines 17, 81, 622 carry the stale sentence | report §0.3 | ✅ exactly those lines |
| `sentinel_org_lookup`: `rolbypassrls=t, rolcanlogin=f, rolsuper=f, rolinherit=f` | ADR, migration spec | ✅ all four |
| Owns `SELECT` on **exactly** two tables | ADR, tenant-isolation.md | ✅ `Membership`, `Organization`, nothing else |
| "is granted to nobody", "inherits nothing" | ADR | ✅ `pg_auth_members` empty in both directions |
| "no default privileges" | tenant-isolation.md | ✅ `pg_default_acl` names only `sentinel_app` |
| `EXECUTE` revoked from `PUBLIC`, granted to `sentinel_app` | ADR, migration | ✅ `proacl = {sentinel_org_lookup=X/…,sentinel_app=X/…}`, no bare `=X/` |
| `sentinel_app` is not `BYPASSRLS` / not superuser | ADR | ✅ both false |
| Compose `DELETE` on `Organization` was realigned (§3.5) | report §3.5 | ✅ now `del = f, upd = t` |
| Slug is "normalised to lower case" | controller `ApiDoc` | ✅ `organizationSlugSchema` has `.toLowerCase()` |
| Every system role holds `organization.read`, so no 403 arm exists for it | `security/authorization.md` | ✅ all 7 roles; `update` = OWNER+ADMIN, `delete` = OWNER only |
| INVITED / REMOVED membership → 404, not 403 | `api/authentication.md` | ✅ `resolveTenant` maps both to `not-a-member`; suspension is checked **after** membership, so a non-member of a suspended org gets 404 — no existence oracle |
| Ruling 99: every new `Membership` read carries `deletedAt: null` | — | ✅ Task 13 adds no unguarded read. The switch inherits `tenant-resolver.store.ts:107`; the SQL function carries `m."deletedAt" IS NULL AND m.status = 'ACTIVE'` |
| Ruling 58: new RLS claims drive `sentinel_app` | — | ✅ all three new integration specs pass `connectAs: 'app'`; the harness really binds `PRISMA` to `postgres.appUrl` (`auth-harness.ts:152`) |
| Testcontainers provisions `sentinel_org_lookup` | implied | ✅ `postgres-harness.ts:7,27` copies the same `01-app-role.sql` |
| `Organization` has no `deletedAt`, so the function needs no org-level soft-delete filter | service docblock | ✅ no such column in `schema.prisma` |
| `sentinel_app` cannot `CREATE` in schema `public` | migration spec | ✅ `has_schema_privilege = f`; `nspacl` grants it `U` only |

**Commit messages.** All ten are accurate to their contents; no commit claims work it does not carry.
`de7fcc6` ("the sentences Task 13 makes false") does touch six `.claude/` documents — but not
`backend.md`, and not the matrix spec's docblock (C2, C3).

**One counting error in the review brief I was given:** it states "9 commits". `git rev-list --count
1310604..HEAD` is **10**. Same authorship as §11; recorded because §11 was placed in scope.

---

## Part 2 — Code findings

### H1 — `SET search_path = public` leaves the definer function open to a `pg_temp` relation hijack **High**

**Files.** `packages/db/prisma/migrations/20260902083622_organization_lookup_function/migration.sql:115`;
the claim repeated at `:81-82`, in ADR-0020's Decision section, in `.claude/security/tenant-isolation.md`,
and in `packages/db/src/migration.integration.spec.ts:286-297`.

**What is wrong.** `SET search_path = public` does not exclude the temporary schema. Postgres
searches `pg_temp` **before** everything for relation names when it is not explicitly listed, so
`"Membership"` and `"Organization"` inside the function body resolve to attacker-supplied temp
relations if any exist. `sentinel_app` holds `TEMPORARY` on the database and can therefore create
them and grant the definer role access to them.

**Measurement.** In Part 1, C4 — full transcript, controls, and the fix verified in the same session.

**Why it matters.** This is the only `BYPASSRLS` object in the system, and it is the object ADR-0020
argues is safe because of four containment properties. One of those four is false. The consequence
of the hijack is not a nuisance: the function joins attacker-controlled `Membership` rows against
the **real** `public."Organization"` under `BYPASSRLS`, which turns it into a cross-tenant
enumeration primitive over every organisation in the database, reachable by a role whose direct
reads of both tables return zero rows.

**Why it is not Critical.** Exploitation requires arbitrary SQL execution as `sentinel_app`. The API
offers no such surface: both raw statements in this task are tagged templates (see **P1**), and
`sentinel_app` cannot `CREATE` in `public`. So this is a defence-in-depth failure and a false
security claim, not a presently reachable vulnerability. It is rated High rather than Medium because
(a) the documented rationale is wrong in four places, one of them a test comment that pins the
vulnerable value, and (b) the fix is one token.

**Fix.** `SET search_path = public, pg_temp` (or `pg_catalog, pg_temp`) — `pg_temp` **last**. Note
that `migration.integration.spec.ts:297` asserts `proconfig` equals `['search_path=public']`
exactly, so the fix requires updating that assertion and its comment; the pin is correct behaviour,
the value pinned is not. Revoking `TEMPORARY` from `PUBLIC` on the database would be defence in
depth, not a substitute.

### M1 — `pnpm test:integration` is not deterministic; a TOTP step-boundary flake fails it **Medium**

**File.** `apps/api/src/modules/auth/auth.mfa.integration.spec.ts` — **not in this change range.**

**Measurement.** Full suite, this tree:

```
EXIT=1
FAIL integration apps/api/src/modules/auth/auth.mfa.integration.spec.ts
  > POST /auth/mfa/confirm > enables the factor, issues ten recovery codes, and emails the owner
AssertionError: expected 59611654 to be 59611655 // Object.is equality
 Test Files  1 failed | 24 passed (25)
      Tests  1 failed | 439 passed (440)
```

Re-run of that file alone: `EXIT=0`, `29 passed (29)`. The values differ by one and
`59611655 × 30 s` lands in the present, so this is a TOTP time-step computed on one side of a
30-second boundary and consumed on the other.

**Why it matters here.** It is pre-existing and not caused by Task 13 — but report §1 and §11.1 both
record `pnpm test:integration | Exit 0` as a settled figure, independently, and neither party saw
this because each ran once. Report §10.6 states CI has not run on this branch. A ~230-second job
with a time-boundary race in it will surface there, and the finished-tree evidence for this task
would then be a figure nobody can reproduce on demand.

**Not a Task 13 defect.** Reported so that the exit code in §1 is not treated as a stable
observation, and so the flake is not diagnosed as a Task 13 regression when CI first goes red.

### M2 — The M2 survivor is real and systemic to the matrix, but the replacement coverage is stronger than the report claims **Medium** (assessment; no code defect)

The brief asked me to assess whether the replacement coverage catches the survivor and whether the
claim about what caught it is true. Both were measured.

**The reported mutation, reproduced exactly.** `@RequirePermission('organization.update')` →
`@AuthenticatedOnly()`:

```
UNIT   EXIT=1   1 failed | 1625 passed (1626)
  FAIL organizations.controller.spec.ts > PATCH ':id' > declares its access arm in metadata rather than by omission
INTEG  EXIT=1   1 failed | 29 passed (30)
  FAIL organizations.scoped.integration.spec.ts > PATCH /:id > answers 403 PERMISSION_DENIED to a role that lacks organization.update
  authorization-matrix.integration.spec.ts — GREEN
```

Report §4's "1 unit + 1 integration, the matrix stayed green" is exactly right, and **its claim
about what caught it is true**: the two named catchers are the two that fired.

**A mutation the report did not run, and the one that mattered most.** `organization.read` is the
route with no possible 403 arm — every system role holds the permission — so on the report's logic
it should be the least defended. Downgrading it:

```
UNIT   EXIT=1   1 failed | 1625 passed (1626)
  FAIL organizations.controller.spec.ts > GET ':id' > declares its access arm in metadata rather than by omission
INTEG  EXIT=1   3 failed | 27 passed (30)
  × GET /:id > answers 404 to a caller with no active organisation at all
  × GET /:id > answers 403 ORGANIZATION_SUSPENDED for a member of a suspended organisation
  × GET /:id > answers 403 MFA_ENROLMENT_REQUIRED when the organisation requires a factor and the member has none
  authorization-matrix.integration.spec.ts — GREEN
```

**This is the answer to the brief's question.** The three integration reds are precisely the controls
that vanish when a route leaves the guarded set — the suspension gate, the MFA-enrolment gate, and
the no-tenant 404 — and they fire without any 403 arm being available. The replacement coverage does
catch the downgrade, on the route where the report implies it would be weakest, through assertions
about the *consequences* of leaving the guarded set rather than about the declaration alone. The
survivor is a real gap in the matrix; it is not an uncovered gap in the product.

**What is systemic.** The matrix stayed green under both downgrades and under M1. Its guarded set is
computed from the declarations it is meant to police, so it cannot see a route leave. Recording it,
as §4 and §10.7 do, is the right call — but the compensating control is `organizations.controller.spec.ts`'s
exact table, and that file is now load-bearing for every guarded route in the product.

### M3 — Matrix arm 3 cannot reach the handler on any guarded route, so it does not test what its docblock says **Medium**

**File.** `apps/api/src/common/authorization-matrix.integration.spec.ts:478-510`.

**What is wrong.** Arm 3 builds a stranger whose session points at `other.organizationId`, an
organisation the stranger has **no membership in**. `TenantContextGuard` therefore resolves
`not-a-member` and answers 404 before the handler executes. The path-id substitution the arm
performs — and the sharper-probe argument in its comment — never gets evaluated by anything.

**Measurement.** Removing the body of `assertPathIsActiveTenant` entirely (a strictly stronger
mutation than report §4's M1, which touched `read()` only):

```
UNIT   EXIT=1   5 failed | 1621 passed (1626)
  all 5 in organization.service.spec.ts > assertPathIsActiveTenant
INTEG  EXIT=1   5 failed | 25 passed (30)
  × GET /:id    > answers 404 for another tenant’s organisation
  × GET /:id    > answers 404 for an organisation the caller belongs to but is not acting in
  × GET /:id    > answers 404, byte-identical, for an id that does not exist
  × PATCH /:id  > answers 404 for another tenant’s organisation, not 403
  × DELETE /:id > answers 404 for another tenant’s organisation, and checks that before the 409
  authorization-matrix.integration.spec.ts — GREEN
```

Consistent with the report's 3-of-30 for the narrower mutation (3 from `read`, plus 1 each for
`PATCH` and `DELETE`). **Cross-tenant isolation bites hard, on all three routes, in both lanes.**
Arm 3 contributed nothing.

**Why it matters.** Arm 3 is §10's exit criterion for cross-tenant behaviour across the whole route
inventory, and it currently certifies only that `TenantContextGuard` refuses a session pointed at a
non-membership. That is worth having, but it is not "answers 404 to a member of a different tenant"
in the sense the file means, and it will not generalise: the next resource whose handler compares a
path id against the tenant gets no coverage from this arm either. The misdescription in report §4
(finding **C7**) is what conceals this.

**Suggested shape.** Give the stranger a real `ACTIVE` membership in the session's organisation as
well, so the guard resolves and the path id is the only thing wrong. That is what the scoped spec's
"belongs to but is not acting in" arm does, and it is why that arm catches M1 while this one does
not.

### L1 — A cursor value that JS accepts and Postgres rejects turns a 400 into a 500 **Low**

**File.** `apps/api/src/modules/organizations/list-cursor.ts:59-62, 86`.

The docblock states the goal explicitly:

> *"what has to be true is that Postgres can compare it as a `timestamptz`, and an ISO string that
> `Date` refuses is one Postgres would refuse too — with a 500 rather than a 400, from inside the
> query."*

Validation is `Number.isNaN(new Date(createdAt).getTime())`, and the **original string** — not the
parsed date — is what reaches the query. The two parsers disagree:

```
JS   new Date('2026')        -> Thu Jan 01 2026 ... (valid)
PG   SELECT '2026'::timestamptz
     ERROR:  invalid input syntax for type timestamp with time zone: "2026"
```

Through the real query shape, as `sentinel_app`:

```
PREPARE p(text,text) AS SELECT id FROM user_organizations('u')
  WHERE ("createdAt", id) < ($1::timestamptz, $2) ...;
EXECUTE p('2026','');
ERROR:  invalid input syntax for type timestamp with time zone: "2026"
```

`OrganizationService.list` has no `catch`, so the Prisma error reaches `AllExceptionsFilter`.

**Impact is small.** No data exposure and no internals leak — the filter produces the standard
envelope. The defect is that a malformed client input answers 500 where `api/errors.md` and this
file's own reasoning say 400, and that the stated mitigation does not do what it says.

**Hypothesis, not measured:** that the HTTP status is 500. I measured the SQL error and read the
filter, but did not drive an end-to-end request with a forged cursor.

**Fix.** Re-serialise: pass `new Date(createdAt).toISOString()` to the query rather than the raw
string, so the value handed to Postgres is one Postgres is known to accept.

### L2 — Blockquote continuation lines lost their `>` prefix in two documents **Low**

`.claude/api/authorization.md:8-9` and `.claude/security/authorization.md:4-5,163-164`. Markdown lazy
continuation means these still render inside the quote, and `pnpm format:check` passes, so nothing is
broken. Noted only because both occur inside the banners this task rewrote, and a later edit that
inserts a blank line there will silently split the banner.

---

## Part 3 — Places I looked hard and found the work sound

A review that lists only defects says nothing about coverage. These were attacked and held.

**P1 — Both raw statements are genuinely parameterised, and no request value reaches the tenant
root's id.** This was §11.2's explicit ask.

- `organization.service.ts` `create`: `tx.$executeRaw\`INSERT INTO "Organization" (id, slug, name,
  "updatedAt") VALUES (${organizationId}, ${command.slug}, ${command.name}, now())\`` — a tagged
  template, so all three are placeholders. `organizationId` is `newId('org')`, minted in the same
  function three lines above; there is no path, query or body field on `POST /organizations` that
  can influence it. The column list is a literal. `$executeRawUnsafe` appears nowhere in the module.
- `remove`: `tx.$executeRaw\`DELETE FROM "Organization" WHERE id = ${ctx.organizationId}\`` — bound
  to the **resolved tenant**, not to `pathId`, and issued inside `withTenantTransaction`, so
  `Organization`'s RLS predicate keyed on `id` is the second line under it.

§11.2's requested confirmation: **confirmed.** The one INSERT layer 1 does not police is over a
locally generated id, and it stays that way today.

**P2 — Cross-tenant isolation holds on all five routes and on `switch-org`, and the tests bite.**
Proven by M3's mutation above (5 unit + 5 integration red). The three cases are genuinely
indistinguishable: the scoped spec compares the whole 404 body byte-for-byte with `requestId`
substituted out, not just the status. `switch-org` maps `no-active-organization` and `not-a-member`
onto one 404 and checks membership **before** organisation status, so a non-member of a suspended
organisation learns nothing — I traced `resolveTenant` specifically for that ordering.

**P3 — Ruling 58 is honoured everywhere it needed to be.** All three new integration specs pass
`connectAs: 'app'`; the harness really rebinds `PRISMA` to the `sentinel_app` DSN; Testcontainers
provisions `sentinel_org_lookup` from the same init script Compose uses. `organizations.integration.spec.ts:225`
asserts the created organisation is invisible to `harness.appPrisma` outside a transaction **and**
visible to the owner client, which is what makes `connectAs: 'app'` load-bearing rather than
decorative.

**P4 — Ruling 100 is honoured, properly.** The removed-membership test writes the two `REMOVED`
organisations **first**, so physical order puts them ahead of the live row, then asserts on the whole
set rather than the head. That is a regression test arranged to lose.

**P5 — Ruling 103 is defended, not merely cited.** Every source-text assertion in
`email-verified.guard.spec.ts` and `require-mfa.spec.ts` strips block and line comments before
matching, so a docblock mentioning the decorator cannot satisfy it; the controller glob is pinned to
an exact length rather than `toBeGreaterThan(0)`; and the results are asserted as **names**
(`toEqual(['organizations.controller.ts'])`) rather than counts. The wrong-directory glob that
shipped once is guarded against in both files.

**P6 — The `sentinel_org_lookup` grants are minimal and I could not widen them.** `SELECT` on
exactly two tables, `USAGE` on one schema, no default privileges, no role memberships in either
direction, `NOLOGIN NOINHERIT`, not a superuser, `EXECUTE` revoked from `PUBLIC`. Every one measured
against the live catalog. The only thing reachable through the function that should not be is the
`pg_temp` hijack in **H1**, and that is a `search_path` defect rather than a grant defect.

**P7 — Ruling 99 holds.** Task 13 introduces no `Membership` read lacking `deletedAt: null`. The
switch service inherits the predicate from `tenant-resolver.store.ts` deliberately rather than
re-deriving it, which is the right call and is argued for in its docblock; the SQL function carries
the predicate in the migration.

**P8 — §11.3's ruling on `ORGANIZATION_DELETED` is correct.** The FK is `onDelete: Restrict`, both
write orders were transcribed with real Postgres error text, and I found no third ordering that
commits. Keeping the name out of `AUDIT_ACTIONS` while leaving it in the taxonomy is the right
split. The only defect in that area is the stale word "four" (**C1**).

---

## Part 4 — What I could not verify

1. **That the `pg_temp` hijack is unreachable through the HTTP API.** I found no reachable path and
   confirmed `$executeRawUnsafe` is absent from the changed modules, but I did not audit every raw
   statement in the pre-existing codebase for injection. **H1**'s severity assumes no such surface
   exists; if one does, H1 becomes Critical.

2. **The HTTP status of the malformed-cursor case (L1).** Measured at the SQL layer and traced to
   `AllExceptionsFilter`; not driven end to end.

3. **Report §3's probe transcripts** (`§3.1`–`§3.4`, `§3.6`). These describe ad-hoc probes against a
   database whose state has since moved — `org_probe_d2` is the accepted leftover, and §3.5's
   `REVOKE` was applied by hand afterwards. I re-derived the *conclusions* independently (the two
   missing grants are in the shipped migration and the function works; `DELETE` is revoked in compose
   now; the FK refuses both orders) but could not replay the transcripts verbatim.

4. **`pnpm test:e2e` and CI.** Not run, per the accepted exclusions. Given **M1**, CI is where the
   integration flake will first be seen.

5. **Whether other Compose privileges have drifted** (report §10.4). The implementer flagged that
   nothing has looked; I checked `Organization`'s `DELETE`/`UPDATE` and the schema-`CREATE` revoke
   and found both correct, but I did not audit the full privilege surface either.

6. **Anything about `roadmap.md`.** Untouched by this task by protocol §3, and untouched by me.

---

## Summary

| | |
|---|---|
| Claims checked | 41 |
| False | 7 (C1–C7) |
| Code findings | 1 High, 3 Medium, 2 Low |
| Mutations applied and watched | 3 (M2-update reproduced, read-downgrade new, `assertPathIsActiveTenant` removal) |
| Tree state | clean; every mutation reverted |

The single most important item is **H1**, because it falsifies one of the four properties ADR-0020
rests its case on, and the ADR is the document licensing the only `BYPASSRLS` object in the product.
The fix is one token in one migration plus the test that pins it.

The second is the citation cluster **C1/C2/C3**: the phase's signature defect recurred three times in
this range, twice in artefacts written *by the correction pass for that same defect*, and once in a
file the task edited. The general defence §11.4 prescribed — compute the count, do not read it — was
prescribed and then not run over the file it was prescribed from.

Against that, the security substance of the task is in good shape. Cross-tenant isolation is real and
its tests bite hard; the raw SQL is parameterised and the tenant root's id is not caller-influenced;
the grants are minimal; and the compensating coverage for the admitted M2 survivor is stronger than
the report claims — measured on the route the report implies is least defended.
