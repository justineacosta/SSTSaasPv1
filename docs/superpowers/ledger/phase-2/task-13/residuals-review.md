# Task 13 — review of the fix round (`c10eeab`) and the residual sweep (`56301f5`)

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../.claude/product/roadmap.md) is the only authority on that.**

Fresh adversarial reviewer, 2026-09-03, on branch `fix/phase-2-task-13-residuals` at `56301f5`.
Two ranges: `git show c10eeab` (the fix round, never reviewed) and `git diff f9664e2..HEAD` (the
sweep). Nothing was committed, fixed or pushed. Every mutation applied here was reverted and
`git status` is clean; the two probe databases and the probe role created in the compose Postgres
were dropped (`pg_database` back to `postgres`, `sentinel`, `template0`, `template1`).

**Result in one line: the security substance is sound and better tested than the previous round,
and the prose about it is still the weak part.** Four measured defects, none of them a
presently-reachable vulnerability; the largest is that a test which three documents and a code
comment describe as pinning a *rule* cannot ever fail.

---

## 0. Baselines, re-measured rather than trusted

Exit codes captured outside a pipe. Every figure the orchestrator supplied reproduced exactly.

| Command | Exit | Figure measured here | Brief said | Agrees |
|---|---|---|---|---|
| `pnpm test` | 0 | **95 files / 1628 tests** | 95 / 1628 | yes |
| `pnpm test:integration` | 0 | **25 files / 443 tests**, 267.5 s | 25 / 443 | yes |
| `pnpm check:specs` | 0 | 120 spec files | 120 | yes |
| `pnpm check:openapi` | 0 | byte-identical, `"routes":21` | 21 paths | yes |
| `pnpm check:registry` | 0 | 15 models, 3 tenant-owned, 1 root, 11 global | 15 | yes |
| `pnpm check:secrets` | 0 | 434 tracked files | 434 | yes |
| `pnpm format:check` | 0 | clean | — | — |
| `pnpm lint` | 0 | 14 tasks | 14 | yes |
| `pnpm typecheck` | 0 | 14 tasks | 14 | yes |
| `pnpm build` | 0 | 8 tasks | 8 | yes |
| `prisma migrate status` (compose) | 0 | **12 migrations found**, "Database schema is up to date!" | — | — |

Two independent derivations of the OpenAPI figure, per ruling 108: the generator logs
`"routes":21`, and parsing the committed `apps/api/openapi.json` gives **21 paths / 24
operations**. `fixes.md`'s "21 paths / 24 operations" is right, and the brief's gloss ("that is
unique *paths*, not operations") is right.

`pnpm test:e2e` was not run — no `apps/web` path is touched in either range, which matches
`fixes.md`'s own statement.

One correction to the *brief* rather than to the repository: it says "all four migrations are
applied locally". There are **twelve** migrations in `packages/db/prisma/migrations/`, all applied.
The brief also glosses carry-forward ruling 104 as "do not verify a number by reproducing the
method that produced it"; ruling 104 in `progress.md` is about a link checker not skipping fenced
code blocks. The instruction was followed anyway — it is good practice and it is what found L1.

---

## 1. Citation pass

Every factual claim I could reduce to a command or a file. **Claims that held are listed too** —
33 held, 7 did not, 3 were not verifiable.

### 1.1 The `c10eeab` commit message and `fixes.md`

| # | Claim | How checked | Result |
|---|---|---|---|
| 1 | `sentinel_app` held `TEMPORARY`; a temp `"Membership"` shadowed the real one | not re-runnable — the revoke has since removed the precondition | **Not re-verifiable now** (see §4); the mechanism is documented Postgres behaviour and the fix is present |
| 2 | The function now pins `search_path = public, pg_temp` | `pg_get_functiondef` on the compose DB | **Holds** — `SET search_path TO 'public', 'pg_temp'` |
| 3 | Fixed forward in a new migration, not by editing the applied one (ruling 2) | `ls migrations/` | **Holds** — `20260902130000_…` is a separate directory |
| 4 | ADR-0021 supersedes ADR-0020; ADR-0020's false sentence stays visible | read both files | **Holds** — ADR-0020 is edited only to add the supersede pointer |
| 5 | "It now pins the rule … so moving it earlier fails with a message naming the rule" | **mutation**: `ALTER … SET search_path = pg_temp, public` | **FALSE — finding M2** |
| 6 | "eleven stale sentences" (commit message) vs "fourteen lines across nine files" (`fixes.md`) | reconciled: 15 total sites − 4 `roadmap.md` sites corrected in `eab2eb8` = 11 in this commit | **Holds** — the two numbers are consistent, not contradictory |
| 7 | "fourteen lines across nine files, plus a tenth" at `1310604` | independent broader grep at `1310604` | **Unreproducible — finding L1.** No pattern is recorded; my derivation finds 21 candidate lines across 11 files |
| 8 | "All are corrected" | family grep at HEAD | **FALSE — finding M4** |
| 9 | `audit.actions.ts` said "All four actions above"; the constant holds three | counted the constant's members mechanically | **Holds** — `AUDIT_ACTIONS` holds exactly `ORGANIZATION_CREATED`, `ORGANIZATION_UPDATED`, `ORGANIZATION_SWITCHED`, and the comment now says "All three" |
| 10 | M3's mutation transcript (arm 3 red on all three routes) | not re-run — reverting the fix is a large mutation on production code; the corrected arm passes today | **Not verified**, low risk |
| 11 | L1: `new Date('2026')` valid, `'2026'::timestamptz` a syntax error | read `decodeListCursor`; the value passed to Postgres is now `parsedDate.toISOString()` | **Holds** |
| 12 | L1: `pnpm test` 1626 → 1628 | measured 1628 | **Holds** |
| 13 | `test:integration` 25 files / 440 at `c10eeab`; 443 at HEAD | 443 measured; the sweep adds exactly 3 tests | **Holds** — arithmetic consistent |
| 14 | `check:secrets` 433 → 434 | measured 434; the sweep adds exactly 1 tracked file | **Holds** |
| 15 | Ruling citations 1, 2, 14, 101 in new comments and migrations | read each ruling in `progress.md` | **All four accurate** |

### 1.2 ADR-0021

| # | Claim | How checked | Result |
|---|---|---|---|
| 16 | "There is exactly one such [`SECURITY DEFINER`] object today" | `SELECT … FROM pg_proc WHERE prosecdef` | **Holds** — one row, `public.user_organizations`, owner `sentinel_org_lookup` |
| 17 | "`sentinel_app` cannot `CREATE` in `public`" | `pg_namespace.nspacl` | **Holds** — `sentinel_app=U/sentinel` (USAGE only); only `sentinel` holds `UC` |
| 18 | "Both raw statements in the request path are parameterised tagged templates" | read `user-organizations.store.ts`; grepped for `$queryRawUnsafe` | **Holds** — `$queryRaw` tagged template, every value a placeholder |
| 19 | "The documented safe form is to write `pg_temp` last" | Postgres semantics, corroborated by the function definition | **Holds** |
| 20 | "the assertion in `migration.integration.spec.ts` is the pattern to copy — not the equality, the rule" | **mutation** (see #5) | **FALSE — finding M2** |

### 1.3 The `56301f5` commit message, the revoke migration, and `tenant-isolation.md`

| # | Claim | How checked | Result |
|---|---|---|---|
| 21 | `has_database_privilege('sentinel_app', current_database(), 'TEMPORARY')` goes `t` → `f` | queried the compose DB | **Holds** — `app = f`, `anyone = f` |
| 22 | `CREATE TEMP TABLE "Membership"` as `sentinel_app` answers `permission denied to create temporary tables in database "sentinel"` | ran it as `sentinel_app` | **Holds — verbatim**, including the database name in the message |
| 23 | `current_database()` + `format('%I')` "quotes the identifier correctly, which a string concatenation would not" | created a database literally named `we-ird "DB"` and ran the DO block against it | **Holds** — `t` → `f`, exit 0, no quoting error |
| 24 | "so it cannot silently do nothing" | **mutation**: ran the same DO block as a non-owner role | **FALSE in the more likely case — finding M1** |
| 25 | "Asserted against a database replayed from empty, separately from the `pg_temp` pin" | read `migration.integration.spec.ts`'s `beforeAll` | **Holds** — its own `PostgreSqlContainer` plus `prisma migrate deploy`, and the assertion is a distinct `it()` |
| 26 | "Nothing in this application creates one — Prisma does not" | grepped the whole tree for `CREATE TEMP`/`TEMPORARY`; ran the full integration suite against containers where the revoke is applied | **Holds** — no occurrence outside migration prose, and 443/443 green with the capability removed |
| 27 | "the only temporary tables ever created in this repository were the hand-written probes" | same grep | **Holds** |
| 28 | "PostgreSQL grants TEMPORARY (and CONNECT) to PUBLIC on every database by default" | observed on the freshly created probe database (`anyone = t` before the revoke) | **Holds** |
| 29 | "the database is `sentinel` … in the Testcontainers harness (`packages/db/src/testing/*.withDatabase('sentinel')`)" | read `postgres-harness.ts` | **Holds** |
| 30 | "ADR-0006's argument is that two mechanisms must both be wrong" | read ADR-0006 | **Holds** — shared DB, mandatory scoping, RLS as second layer |
| 31 | "`git ls-remote --heads origin` returns `main` alone" | ran it | **Holds** — one ref, `refs/heads/main`, at `f9664e2` |
| 32 | "One probe row, `org_probe_d2` … Still true on 2026-09-03" | queried the compose DB | **Holds** — the row exists, with 1 referencing `AuditEvent` |
| 33 | "lifting the trigger to tidy dev data was refused by the harness's permission classifier" | — | **Not verifiable** — a claim about a past tool interaction, no artefact |

### 1.4 The TOTP fix

| # | Claim | How checked | Result |
|---|---|---|---|
| 34 | "`lastAcceptedStep` is fixed when the code is generated" | read `mfa-enrolment.service.ts:200-222` and `verifyTotpCode` | **Holds** — the service writes the step `verifyTotpCode` *matched*, not `stepAt(now)` |
| 35 | "the failure rate is the span divided by 30,000 ms — about 3% at a one-second span" | arithmetic: a 30 s boundary falls inside a span of D ms with probability D/30000; 1000/30000 = 3.3 % | **Holds** |
| 36 | "so no wall-clock timing can affect it" | reasoned against the ±1 drift window: a boundary crossing between generation and verification still matches step *S*, so `lastAcceptedStep === confirmingStep` | **Holds** — the flake is removed, not moved |
| 37 | "which is exactly how it presented" | one observed failure in four runs | **Weak** — consistent with the model, not evidence for it. Rhetorical over-claim, not a false statement |

### 1.5 `pagination.md`'s new banner — every clause

| # | Clause | How checked | Result |
|---|---|---|---|
| 38 | "one endpoint consumes them … `GET /api/v1/organizations`" | enumerated `openapi.json`; it is the only list route | **Holds** |
| 39 | "applies the default and the clamp, echoes the applied limit" | `listQuerySchema` (`.default(50)`, `Math.min(value, 100)`) and `organization.service.ts#list` (`Math.min` again, `limit` echoed) | **Holds** |
| 40 | "paginates by keyset on `(createdAt, id)` with the opaque cursor §1 describes" | `user-organizations.store.ts`: `WHERE ("createdAt", id) < (…) ORDER BY "createdAt" DESC, id DESC LIMIT n+1`; cursor is base64url JSON | **Holds**, including §1's "one extra row determines hasMore" |
| 41 | "no endpoint accepts `?includeTotal=true`, nothing returns `meta.total`, and the `reltuples` estimate … does not exist" | grepped the tree for all three | **Holds** — zero implementation hits |
| 42 | "`listQuerySchema` is `.strict()`" | read `packages/contracts/src/pagination.ts` | **Holds** |
| 43 | "`?includeTotal=true` is refused at 400 rather than silently ignored" | the new integration test passes in the 443-green run; ruling 14's asymmetric split matches (a sole `unrecognized_keys` issue → `UNKNOWN_FIELD`) | **Holds** |
| 44 | "§5's `?sort=` allowlist; and offset pagination" still unimplemented | the `.strict()` schema has neither field | **Holds** |
| 45 | Until Task 13 the banner read "no endpoint consumes them yet — there is no list endpoint in the API" | `git show f9664e2:.claude/api/pagination.md` | **Holds — verbatim** |

### 1.6 The matrix sentinel's own prose

| # | Claim | How checked | Result |
|---|---|---|---|
| 46 | "Measured then — downgrading `organization.update` turned exactly one unit test and one integration test red and left this whole file green" | read `review.md` M2's transcript | **Holds** — 1 unit + 1 integration, matrix green; and `review.md`'s additional `organization.read` mutation (1+3) is correctly reported as a different case |
| 47 | "A count would be weaker … adding one route while downgrading another keeps the number identical" | reasoning about `toEqual` on a map versus a length | **Holds** |
| 48 | "Proved by re-running the mutation the old matrix survived" | **re-ran it myself** | **Holds** — see §3 |
| 49 | Carry-forward ruling 101 says a sentinel that fails on the day the feature arrives must say what replaces it | read ruling 101 | **Holds — verbatim** |

### 1.7 Two things that looked like a fifth miscount and are not

- **`.claude/security/audit.md:88-91`** reads "The three registration and verification names were
  added in Phase 2 Task 8… **All four** are written into `PlatformAuditEvent`." Adjacent 3 and 4,
  in a file with a miscount history. **Checked by `git show b7984ac`:** Task 8 added exactly three
  names (`USER_REGISTERED`, `REGISTRATION_BLOCKED_EXISTING_EMAIL`, `EMAIL_VERIFICATION_RESENT`) to
  a list that already held `EMAIL_VERIFIED`, and "all four" refers to the four-name group. **Both
  sentences are correct.** Confusing, not wrong.
- **`.claude/api/errors.md:79` and `.claude/api/authentication.md:311`**, which say
  `MFA_ENROLMENT_REQUIRED` has no shipped producer, look like survivors of the stale-sentence
  family. **They are true** — see finding M3, where it is `roadmap.md` that is wrong.

---

## 2. Code findings

### M1 (Medium) — the revoke migration cannot fail: run by a non-owner it warns, does nothing, and exits 0

**File:** `packages/db/prisma/migrations/20260903090000_revoke_temporary_from_public/migration.sql:56-60`
**Also:** `packages/db/src/migration.integration.spec.ts:341-365` — the assertion that cannot see it

The migration's own comment says a literal database name "would be a migration that silently does
nothing the first time somebody runs it against a differently-named database — and 'silently does
nothing' is the failure mode this repository keeps finding". `current_database()` closes the
*name* variant. It does not close the *privilege* variant, which is the more likely one:
`REVOKE … FROM PUBLIC` issued by a role that is neither the database owner nor a superuser is a
**warning**, not an error.

Measured, on a database owned by `sentinel` with the migration's DO block run verbatim as an
ordinary login role:

```
 current_user  | before
----------------+--------
 probe_deployer | t

WARNING:  no privileges could be revoked for "revoke_probe"
DO
 after_revoke
--------------
 t
```

`psql` was running with `ON_ERROR_STOP=1`; the block still completed and the script exited 0.
Under `prisma migrate deploy` that records the migration as applied, so it never runs again, and
the *only* assertion of the property lives in `migration.integration.spec.ts` — which runs against
Testcontainers, where the migrator **is** the superuser. The property is therefore asserted
exclusively in the one environment in which it cannot fail.

**Why it matters.** `operations/deployment.md` §3 says migrations run "as a one-shot job" and §6
puts Postgres on a managed service; it never states which role the job connects as, and managed
Postgres commonly hands out a non-superuser role that does not own the database.
`security/tenant-isolation.md` now states, in the present tense, that `TEMPORARY` "is revoked from
`PUBLIC`". On such a deployment that sentence would be false and nothing would say so.

**The repository already has the fix shape.**
`20260902083622_organization_lookup_function/migration.sql:92-93` uses
`IF NOT EXISTS (…) THEN RAISE EXCEPTION` for exactly this reason. Three lines in the same DO block
— `IF has_database_privilege('public', current_database(), 'TEMPORARY') THEN RAISE EXCEPTION …` —
would turn a silent no-op into a named failure telling the operator which role must run it.

**Confidence:** demonstrated, not hypothesised. What I did *not* determine is which role a real
Sentinel deployment would use, because no document says.

---

### M2 (Medium) — the assertion that four artefacts call "the rule, not the value" can never fail

**File:** `packages/db/src/migration.integration.spec.ts:302-309`

```ts
expect(searchPath).toEqual(['search_path=public, pg_temp']);   // line 302
// …
expect(entries).toContain('pg_temp');                          // line 308
expect(entries[entries.length - 1]).toBe('pg_temp');           // line 309
```

**Mutation applied:** `ALTER FUNCTION … SET search_path = pg_temp, public` — the exact edit the
rule assertion was written for. Measured:

```
FAIL  packages/db/src/migration.integration.spec.ts > … with a pinned search_path
AssertionError: expected [ 'search_path=pg_temp, public' ] to deeply equal
                         [ 'search_path=public, pg_temp' ]
 ❯ packages/db/src/migration.integration.spec.ts:302:26
Test Files  1 failed (1)   Tests  1 failed | 10 passed (11)
```

It fails at **line 302**, on the equality, with a plain deep-equal message. Lines 308-309 never
execute: `expect` throws and the test aborts.

This is not specific to my mutation. `toEqual` on the whole array fixes every element, so
`searchPath` passing line 302 implies `entries === ['public', 'pg_temp']`, which satisfies both
rule assertions by construction. **There is no state in which lines 308-309 can fail.** They are
dead assertions.

**Four artefacts assert the opposite**, all inside the `c10eeab` range:

- `migration.integration.spec.ts:303-307` — "Asserted separately from the equality above so that a
  future edit which keeps `pg_temp` but moves it earlier … fails with a message naming the actual
  rule."
- `ADR-0021`, Decision — "fails with a message naming the actual rule **rather than an equality
  mismatch**." Measured: an equality mismatch is exactly what it produces.
- `ADR-0021`, Consequences — "the assertion in `migration.integration.spec.ts` is the pattern to
  copy — **not the equality, the rule**."
- `.claude/security/tenant-isolation.md` — "the assertion to copy is the one … that pins the
  *rule* — present, and last — not only the value."

**Why it matters.** The security property *is* pinned, by the equality, so nothing is presently
exploitable. What is false is the stated mechanism, and it has a consequence: ADR-0021 itself says
that if a later migration schema-qualifies the body, `pg_catalog, pg_temp` "becomes free and
should be taken". That change fails line 302, and the natural repair is to edit the expected
string — after which lines 308-309 are still unreachable and the rule has still never guarded
anything. A future author told to "copy the rule, not the equality" would copy two assertions that
assert nothing. Neither carries a custom message either, so nothing in the failure output names
the rule.

**Fix shape:** assert the rule *first* — parse `proconfig`, assert `entries.at(-1) === 'pg_temp'`
with a message naming the rule — and only then assert the value; or replace the whole-array
equality with "the rule, plus `public` is present".

---

### M3 (Medium) — `roadmap.md` says `MFA_ENROLMENT_REQUIRED` now has a reachable producer; the code says it does not, and three other documents agree with the code

**Files:** `.claude/product/roadmap.md` ("What Task 13 built") against `.claude/api/errors.md:79`,
`.claude/api/authentication.md:311`, `.claude/security/authentication.md:334`,
`apps/api/src/modules/auth/require-mfa.ts:33-35`

`roadmap.md` states: "**`MFA_ENROLMENT_REQUIRED` has a reachable producer for the first time.**"

`MfaEnrolmentGuard` refuses only when `Organization.requireMfa` is true
(`tenant-resolver.store.ts:180-193`). **Nothing in the API can set that column.** Measured by
enumerating every write path:

- `schema.prisma:90` — `requireMfa Boolean @default(false)`.
- `organization.service.ts:286` — the create path comments that `status`, `createdAt` and
  `requireMfa` "take their column defaults".
- `PATCH /organizations/:id` updates `name` only; carry-forward ruling 15 records `requireMfa` as
  a field Task 13 would have had to rebuild the schema to add, and it did not.
- `db:seed` seeds reference data only.

So no sequence of API calls produces a row with `requireMfa = true`, and no caller can obtain a
`MFA_ENROLMENT_REQUIRED`. The guard now *evaluates* (Task 13 shipped guarded routes and the first
writer of `activeOrganizationId`), which is a real change — but "a reachable producer" is this
repository's own phrase for the stronger claim, used verbatim in the three documents that deny it.
`organizations.scoped.integration.spec.ts` reaches the 403 by seeding `requireMfa` through the
owner client, not through the API, which is consistent with the denial.

**Why it matters.** Two `.claude/` documents now contradict each other about the status of a
security control, and the one that is wrong is `roadmap.md`, which `CLAUDE.md` names as the single
source of truth. A reader closing out Phase 2 against the roadmap would record an enforced control
that no caller can trigger.

**Scope note:** this sentence was added in `eab2eb8`, outside both review ranges, but the sweep
rewrote the section forty lines below it and the brief asked for `roadmap.md`'s claims to be
verified.

---

### M4 (Medium) — the stale-sentence correction is incomplete, and one survivor is a line the count's own grep matched

`fixes.md` and `roadmap.md` both say the fourteen (+1) sites were counted mechanically and "**All
are corrected.**" At HEAD they are not. Every row below was checked against the code at HEAD.

| Site | Sentence at HEAD | Why it is false now |
|---|---|---|
| `apps/api/src/app.module.ts:174` | "Acts only on a route declaring `@RequirePermission()`, **which no shipped route does yet**" | three routes declare one. **This exact line is in the `1310604` grep set** (then `app.module.ts:163`), and `c10eeab` edited this file — the diff corrects the `TenantContextGuard` comment forty lines above and leaves this one |
| `apps/api/src/app.module.ts:163-165` | "**Each governs zero routes today** … No handler carries `@RequireVerifiedEmail()` (Task 13 applies the first) and no organisation can be created to set `requireMfa` (also Task 13)" | `organizations.controller.ts:109` carries `@RequireVerifiedEmail()`; `POST /organizations` creates organisations. This is the "Task 13 in the future tense" defect the matrix docblock was corrected for |
| `.claude/product/roadmap.md:96` | "**All three govern zero routes**: no handler carries `@RequireVerifiedEmail()`, no organisation can be created to set `requireMfa` …" | the same two clauses. **This is inside `## Current state — 2026-09-02`**, fifteen lines below line 81, which the same task corrected to say the three guarded routes exist. The section heading's date was not moved either |
| `.claude/product/roadmap.md:1724` | "**no existing endpoint declares a permission**" | in the Task 12 exit-criteria evidence table; also in the `1310604` grep set (line 1722 then), uncorrected while its three sibling `roadmap.md` sites were corrected |
| `.claude/product/roadmap.md:1766` | "`MfaEnrolmentGuard` acts only on a route declaring a permission, **and no route declares one**" | eleven lines below a sentence in the same paragraph block that *was* given an "until Task 13" qualifier |
| `.claude/api/authentication.md:182,187` | "`permissions` **is always `[]`**"; "`activeOrganization` … **currently always resolves to `null`**" | `switch-org` writes `Session.activeOrganizationId`; a switched session resolves a tenant and a non-empty permission set |
| `.claude/api/authorization.md:61` | "**It is `[]` on every session that exists** … so the observable response has not changed" | same. `c10eeab` edited this file (the L2 blockquote fix) |
| `apps/api/src/modules/auth/auth.controller.ts:500-505` | "still `[]` on every session that exists … **no caller can yet observe a non-empty one**" | same |
| `apps/api/src/modules/auth/session-document.service.ts:31,64` (and `…spec.ts:77,118`) | "still `[]` for every session this phase can create"; "every session this phase can create carries `null` and **the lookup below never runs**" | same |
| `apps/api/src/modules/roles/authorization.integration.spec.ts:117` | "the API has no endpoint that creates an organisation until Task 13 and **no endpoint that sets a session's active organisation at all**" | `POST /auth/switch-org` does exactly that. `c10eeab` edited this file, rewriting the docblock seventy-five lines above |
| `apps/api/src/modules/auth/require-mfa.ts:33-35` and `.claude/security/authentication.md:333-334` | "there is **no way to create an organisation yet**, so no row can carry `requireMfa = true`" | right conclusion (see M3), **false premise**: organisations can be created; what cannot be set is `requireMfa` |

**Why it matters.** These are the two facts a Phase 3 implementer reads first — whether the
authorization pipeline governs anything, and whether a session can carry a tenant. The
repository's own ruling 108 exists because this defect keeps recurring; the correction pass that
produced ruling 108 left at least eleven instances standing, two of them in files it edited and
one of them inside the grep output it counted.

**Checked and correct, not reported as defects:** `access.decorator.ts:96`, `ctx.decorator.ts:36`,
`auth-harness.ts:118`, `authentication.guard.spec.ts:351` and `security/authorization.md:9` all say
"the arms **no shipped route exercises**", which is still true — the fixture controllers cover role
and arm combinations the three organisation routes cannot express.
`organizations.scoped.integration.spec.ts:27` uses the past tense correctly.

---

### L1 (Low) — the "fourteen lines across nine files" count is unreproducible

`fixes.md`, `roadmap.md` and ruling 108 all state the figure as the output of "one `git grep` for
the sentence family over `.claude/` and `apps/api/src/` at `1310604`". **The pattern is not
recorded**, so the number cannot be re-derived by anyone — which is precisely what ruling 108 was
written to prevent. "*Compute*, not *check carefully*" only helps if the computation is repeatable.

My own derivation at `1310604`, deliberately broader (any line mentioning `RequirePermission`, "no
route/endpoint", "zero routes", "guarded route", "does yet"), returns **21 lines across 11 files**:
`api/authorization.md` ×3, `architecture/backend.md` ×2, `roadmap.md` ×4, `security/authorization.md`
×2, `app.module.ts`, `authorization-matrix.integration.spec.ts` ×3, `ctx.decorator.ts`,
`authorization.guard.ts`, `require-mfa.spec.ts`, `roles/authorization.integration.spec.ts` ×2,
`auth-harness.ts`. Some of those are not members of the family under a stricter reading.

I am **not** claiming fourteen is wrong. I am claiming it is unfalsifiable as written, and that the
gap between 14/9 and 21/11 is where finding M4's survivors live. The cheap repair is to paste the
pattern next to the number.

---

### L2 (Low) — the downgrade sentinel's message misdiagnoses two of the four cases it will meet

**File:** `apps/api/src/common/authorization-matrix.integration.spec.ts:505-515`

The message offers exactly two diagnoses: "you ADDED a guarded route" or "a `@RequirePermission()`
was downgraded … or removed". Measured against a **path rename** (`@Delete(':id')` →
`@Delete(':id/archive')`), both halves are wrong — nothing was added and nothing was downgraded —
and the message's instruction ("it must not be fixed by editing the list") is the opposite of the
correct action for a legitimate rename. The Vitest diff rescues it by naming both the removed and
the added key, so a reader is not actually misled; the prose is.

The same message says a disappearance means "arms 2-4 below now cover one endpoint fewer". Arm 1
(line 517) filters on `access?.kind !== 'permission'` too, so it is arms 1-4 — harmlessly, because
a downgraded route is still non-public and is still covered by the separate 401 block above.

Cost of the finding: one sentence. Reported because this file's own standard is that a failure
message must tell the truth about what happened.

---

## 3. Where the work is sound, measured rather than assumed

I attacked these and could not break them. Recorded so the reader knows what the review covered.

**The downgrade sentinel bites, on every shape I tried.** Three mutations, each applied to the
working tree and reverted:

| Mutation | Result |
|---|---|
| `@RequirePermission('organization.update')` → `@AuthenticatedOnly()` | **1 failed \| 12 passed.** The diff names the removed key: `- "PATCH /api/v1/organizations/:id": "organization.update"`. Every other arm still green — the sentinel is the only thing in the file that catches it, which is exactly the gap Task 13's M2 described |
| `organization.delete` → `organization.read` on `DELETE` | **1 failed \| 12 passed.** The diff names the changed value. Notably arm 2 still passed: `organization.read` is held by every role, so the 403 arm silently became inapplicable for that route and only the sentinel noticed |
| `@Delete(':id')` → `@Delete(':id/archive')` | **1 failed \| 12 passed.** The diff shows the removed and the added key. This is also the "added a guarded route" case, and it is caught |

**The `TEMPORARY` assertion bites.** Replacing the migration's `EXECUTE format(…)` with
`PERFORM 1;` turns exactly one test red — `revokes TEMPORARY from PUBLIC, so sentinel_app cannot
create the shadowing table`, `expected true to be false` at line 360 — and leaves the other ten
green. Reverted.

**ADR-0021's fix is complete for the object it protects, and I looked for others.** Queried
`pg_proc` rather than reading: **one** `SECURITY DEFINER` function in the whole database. The only
other user-defined function, `audit_event_is_append_only`, is `SECURITY INVOKER`, so shadowing it
buys an attacker nothing they do not already have. `nspacl` shows `sentinel_app` and
`sentinel_org_lookup` hold `USAGE` and not `CREATE` on `public`, which closes the residual that
`public` being *first* would otherwise open — an exact-match function or operator in `public` can
outrank a `pg_catalog` builtin that needs an implicit cast. RLS policy expressions (`pg_policies`)
are stored parse trees referencing `current_setting` by OID and are not re-resolved against
`search_path`. `pg_extension` holds only `plpgsql`. ADR-0021's own "Alternatives considered" states
the `pg_catalog, pg_temp` trade-off honestly rather than eliding it.

**Nothing in this repository needs temporary tables, and that is now measured rather than argued.**
The full integration suite — 25 files, 443 tests, including every spec that drives the application
as `sentinel_app` — runs green against Testcontainers where this migration has been applied, so the
capability was removed and nothing noticed. A grep of the whole tree finds no `CREATE TEMP` outside
migration prose. Two further hazards I checked and found closed: the shadow database
`prisma migrate dev` creates gets its own revoke by way of `current_database()`, and
`infra/docker/postgres/init/01-app-role.sql` grants only `CONNECT` on the database, so nothing
re-grants `TEMPORARY` to `sentinel_app` by name — and if something ever did, the new test's
`app === false` assertion would catch it.

**The TOTP fix removes the flake rather than moving it.** `verifyTotpCode` returns the step it
*matched*, and `mfa-enrolment.service.ts:222` writes that value, so `lastAcceptedStep` is the step
the code was generated at even when a 30-second boundary falls between generation and verification
(the ±1 drift window absorbs it). Capturing `confirmingStep` at the single clock reading therefore
makes the assertion independent of wall-clock timing, not merely less likely to trip.

**No other spec recomputes a time-derived value the system committed to.** I read all 94
`Date.now()` occurrences across the spec files. They fall into three sound categories: unique-suffix
generation (`matrix-${Date.now()}`), fixture construction (`new Date(Date.now() + 600_000)`), and
before/after bracketing (`token.service.spec.ts:188-193`, `login.service.spec.ts:391`,
`session.service.spec.ts:420`, which allows an hour of slack against a two-hour value). The one
remaining case worth naming, `nextCodeFor` at `auth.mfa.integration.spec.ts:188`, generates
`stepAt(now) + 1` and is safe: a boundary crossing leaves the submitted code at the server's
current step, which is still ≥ `minimumStep` and still inside the drift window.

**The `?includeTotal=true` test asserts what a client trusting the document actually receives**, and
every clause of the new banner checked out (rows 38-45 above). `pagination.md` §3 remains honestly
labelled Designed-Not-Implemented rather than half-shipped, and the endpoint's refusal is the
behaviour the banner claims.

---

## 4. What I could not verify, and why

- **The original hijack transcript.** The `t → f` revoke is applied to the compose database, so
  `CREATE TEMP TABLE "Membership"` now fails for `sentinel_app` and the ADR-0021 attack cannot be
  re-run as written. I did not grant `TEMPORARY` back to reproduce it: that is a database-wide
  privilege change on a shared dev database, and the brief forbids leaving mutations behind. The
  mechanism is documented PostgreSQL behaviour, two independent parties reproduced it before me,
  and the fix is visible in `pg_get_functiondef`. **Hypothesis, not measurement:** the transcript is
  accurate.
- **M3's fix transcript** in `fixes.md` (the arm-3 mutation) was not re-run; reverting
  `assertPathIsActiveTenant` is a large mutation on production code, and the corrected arm passes
  today.
- **Which role applies migrations in a real deployment.** `operations/deployment.md` never says.
  That is why M1 is rated Medium rather than High: I demonstrated the mechanism, not that any
  planned deployment hits it.
- **Whether the "fourteen lines" count was right** — unreproducible without the pattern (L1).
- **CI.** Nothing is pushed; `git ls-remote` shows `main` alone, at `f9664e2`. Every figure in this
  document is local, on Windows, against Docker Desktop.
- **`pnpm test:e2e`** — not run, no `apps/web` path in either range.

---

## 5. Suggested dispositions

| # | Finding | Suggested |
|---|---|---|
| M1 | The revoke migration cannot fail loudly | Fix — three lines in the existing DO block; the precedent is in the sibling migration |
| M2 | The "rule" assertion is unreachable; four artefacts say otherwise | Fix the assertion order **and** correct all four sentences. The claim is the defect, not the test |
| M3 | `roadmap.md` against three documents on `MFA_ENROLMENT_REQUIRED` | Decide which is true — the code says the three documents are — and correct the other |
| M4 | Eleven-plus uncorrected stale sentences, two in files the fix round edited | Fix, and record the grep pattern this time |
| L1 | Count unreproducible | Paste the pattern beside the number |
| L2 | Sentinel message misdiagnoses a rename | One sentence |

Ruling candidates, offered rather than asserted:

- **An assertion placed after an equality that subsumes it can never fail.** Order the specific
  assertion before the general one, or the "rule" is decoration. Measured here on the very
  assertion an ADR names as the pattern to copy.
- **A migration whose failure mode is a `WARNING` is a migration that cannot fail.** `REVOKE`,
  `GRANT` and `ALTER … OWNER TO` all no-op with a warning for an under-privileged caller. A
  migration that asserts a security property must verify that property in the same transaction.
