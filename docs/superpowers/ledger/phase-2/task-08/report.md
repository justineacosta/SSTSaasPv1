# Phase 2 · Task 8 — Registration and email verification · implementer report

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-28. Branch `feat/phase-2-task-08`, cut from `main` at `a39f4b3`. Eleven commits,
`bc00ff7` (ADR-0019, pre-existing on the branch) through `abcb47c`. Nothing pushed.

---

## 1. What I built

### Database

| File | What |
|---|---|
| `packages/db/prisma/schema.prisma` | `model PlatformAuditEvent` (ADR-0019). Also a comment on `VerificationToken`'s `@@index` recording that a partial unique index exists which Prisma cannot see. |
| `packages/db/prisma/migrations/20260828051452_platform_audit_event/migration.sql` | Table, three indexes, `REVOKE UPDATE, DELETE … FROM sentinel_app`, two append-only triggers, and a `CREATE OR REPLACE` of `audit_event_is_append_only()`. SQL in full in §2. |
| `packages/db/prisma/migrations/20260828051500_verification_token_partial_unique/migration.sql` | `UNIQUE (userId, purpose) WHERE "consumedAt" IS NULL`, hand-written. Carry-forward ruling 32. |
| `packages/db/src/id.ts` | `pau` added to `ID_PREFIXES`. |
| `packages/db/src/id-prefix-parity.spec.ts` | `pau` added to `DB_ONLY_PREFIXES` with a reason. **This deviates from the brief — see §6, finding F1.** |
| `packages/db/src/tenant-resources.ts` | `PlatformAuditEvent` added to `DELIBERATELY_GLOBAL_MODELS`. |

### API — new files

| File | What |
|---|---|
| `apps/api/src/modules/auth/auth.controller.ts` | The three routes. All `@Public()`, all `@HttpCode(200)`, each with a `@RateLimit()` class and an `@ApiDoc()`. |
| `apps/api/src/modules/auth/registration.service.ts` | `POST /register`. |
| `apps/api/src/modules/auth/email-verification.service.ts` | `POST /verify-email` and `POST /resend-verification`. |
| `apps/api/src/modules/auth/auth-mailer.ts` | The two sends, and the one place a send failure is absorbed. |
| `apps/api/src/modules/auth/identity.store.ts` | The narrow Prisma port both services see, plus `isUniqueConstraintViolation`. |
| `apps/api/src/modules/auth/request-context.ts` | `ip` / `userAgent` / `requestId` lifted off the Express request at the controller. |
| `apps/api/src/modules/audit/platform-audit.service.ts` | `record(tx, input)`. Takes the caller's transaction; holds no client. |
| `apps/api/src/modules/audit/platform-audit.actions.ts` | The four action names and the resource types. |
| `apps/api/src/modules/audit/audit.module.ts` | Provides and exports `PlatformAuditService`. |
| `apps/api/src/common/guards/email-verified.guard.ts` | The gate. **Registered in no module.** |
| `apps/api/src/common/decorators/email-verified.decorator.ts` | `@RequireVerifiedEmail()`. **Carried by no route.** |
| `apps/api/src/testing/auth-harness.ts` | Real app + Testcontainers Postgres + recording mailer, for the two integration specs. |
| `apps/api/src/testing/identity-fakes.ts` | Recording doubles for the two unit specs. |

### API — changed files

| File | What |
|---|---|
| `apps/api/src/modules/auth/token.service.ts` | `issueInTransaction` and `consumeInTransaction` extracted; `issue`/`consume` are now wrappers. The "partial index is deliberately not here" docblock replaced with the fact that it now exists. |
| `apps/api/src/modules/auth/auth.module.ts` | `controllers: [AuthController]`, imports `MailModule` and `AuditModule`, three new providers, none exported. |
| `apps/api/src/modules/auth/emails/notice.templates.ts` | `renderRegistrationAttempt` — the eighth template. `NOTICE_FOOTER` split so the new template does not tell the recipient to change a password nothing touched. |
| `apps/api/src/modules/auth/emails/registry.ts` | Eighth member, added to `NOTICE_TEMPLATE_IDS`. |
| `apps/api/src/common/guards/rate-limit.config.ts` | `emailVerificationConsume` — 30/hour per IP, `failMode: 'closed'`. |
| `apps/api/openapi.json` | Regenerated. 7 routes. |

### Specs

New: `email-verified.guard.spec.ts` (16), `platform-audit.service.spec.ts` (7),
`registration.service.spec.ts` (15), `email-verification.service.spec.ts` (11),
`auth.enumeration.integration.spec.ts` (8), `auth.verification.integration.spec.ts` (13).
Extended: `token.service.integration.spec.ts` (+3), `rate-limit.config.spec.ts` (+4 assertions),
`auth.module.spec.ts` (+2 tests, 1 rewritten), `registry.spec.ts` (+1 registry member, which the
`Record<EmailTemplateId, …>` table turns into 9 more generated cases).

### Documents

`.claude/security/audit.md`, `.claude/security/authentication.md`,
`.claude/api/authentication.md`, `.claude/security/abuse-prevention.md`,
`.claude/architecture/backend.md`. No `roadmap.md` edit.

---

## 2. The migration SQL, in full

Both files were written with `pnpm db:migrate:create` / by hand, then applied with `pnpm db:migrate`
(exit 0, both applied, `prisma generate` re-run automatically).

### `20260828051452_platform_audit_event/migration.sql`

```sql
-- Actions with no organisation get their own audit table (ADR-0019).
--
-- `CLAUDE.md`'s tenth critical rule says every security-relevant action writes an
-- audit event in the same transaction as the change. Registration and email
-- verification are the first two such actions that have NO organisation: both
-- happen before the account belongs to anything.
--
-- `AuditEvent` cannot hold them, and the column type is only the first of four
-- obstructions:
--
--   1. `AuditEvent."organizationId"` is NOT NULL with a `Restrict` foreign key to
--      `Organization`. There is no id to put there that is not a fabrication.
--   2. The table carries row-level security —
--      `USING/WITH CHECK ("organizationId" = current_setting('app.organization_id', true))`,
--      from `20260820121229_row_level_security`. Measured on 2026-08-28 against a
--      scratch table carrying that exact policy, as `sentinel_app`: the
--      tenant-scoped insert succeeded and the NULL-organisation insert was refused
--      with `new row violates row-level security policy`. Relaxing the column to
--      nullable therefore does not make the write work; the policy rewrite is the
--      real decision, and ADR-0019 declines it.
--   3. `security/audit.md` §6 promises that no API exposes another tenant's
--      events. Rows belonging to nobody, sitting in the table every tenant reads,
--      would be a question every future query has to keep answering correctly.
--   4. `pnpm check:registry` requires each model to be accounted for by exactly
--      one of tenant-owned / tenant-root / deliberately-global. A table that is
--      tenant-owned for most rows and global for some has no honest entry.
--
-- So: a second table with the same fields minus `organizationId`, registered as
-- deliberately global, and carrying the same tamper resistance. `AuditEvent` is
-- untouched — its column stays NOT NULL, its policy stays as written, and every
-- query already pointed at it keeps its current meaning.
--
-- This migration is sound on its own: it creates one table, its indexes, its
-- grants and its triggers, and changes nothing that already exists apart from
-- widening the append-only trigger function's message (see below).

-- CreateTable
CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_createdAt_idx" ON "PlatformAuditEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_actorId_createdAt_idx" ON "PlatformAuditEvent"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_resourceType_resourceId_idx" ON "PlatformAuditEvent"("resourceType", "resourceId");

-- ---------------------------------------------------------------------------
-- Tamper resistance, identical to `AuditEvent`'s (security/audit.md §2).
--
-- `infra/docker/postgres/init/01-app-role.sql` sets ALTER DEFAULT PRIVILEGES
-- granting SELECT, INSERT, UPDATE, DELETE on every future table to
-- `sentinel_app`, so the new table arrives with UPDATE and DELETE already
-- granted. The revoke below is therefore not belt-and-braces: without it this
-- table is writable in place by the application role.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "PlatformAuditEvent" FROM sentinel_app;

-- The function `audit_event_is_append_only()` already exists, from
-- `20260820121229_row_level_security`. It is REUSED rather than duplicated
-- (ADR-0019), and replaced here only so its message names the table the trigger
-- actually fired on. The previous text hard-coded `AuditEvent`, which would have
-- reported the wrong table for every refusal on `PlatformAuditEvent` — an
-- operator reading that during an incident would look at the wrong log. Both of
-- `AuditEvent`'s existing triggers keep pointing at this same function and their
-- behaviour is unchanged apart from the table name in the message.
CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_audit_event_no_update
  BEFORE UPDATE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER platform_audit_event_no_delete
  BEFORE DELETE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

-- No row-level security policy, and no `ENABLE ROW LEVEL SECURITY`, deliberately.
-- RLS on this table would have nothing to filter on: the rows carry no
-- organisation, which is the whole reason the table exists. It is registered as
-- deliberately global in `packages/db/src/tenant-resources.ts`, which is the
-- account `pnpm check:registry` requires. A tenant cannot read a platform event
-- because no tenant-facing query points at this table, and Phase 3's `/audit-logs`
-- will have to union the two deliberately — ADR-0019 names that as the cost.
```

**One statement in that file changes existing behaviour and the operator should look at it
specifically:** the `CREATE OR REPLACE FUNCTION`. The Phase 1 function raised
`'AuditEvent is append-only: % is not permitted'` with the table name hard-coded; it now raises
`'% is append-only: % is not permitted'` with `TG_TABLE_NAME`. `AuditEvent`'s two triggers keep
pointing at the same function, so their message text changes. I grepped the repository for the old
literal before doing it: it appears in this migration, in the Phase 1 migration, and in two ledger
and plan documents — **no spec asserts it**. If the operator would rather have two functions, that
is a one-line change to this file plus a second `CREATE FUNCTION`.

### `20260828051500_verification_token_partial_unique/migration.sql`

```sql
-- One live verification token per (user, purpose), enforced by the database.
--
-- Carry-forward ruling 32, owed since Task 4 and assigned to "the next task that
-- opens a migration". Tasks 6 and 7 opened none; Task 8 opens one, so it is paid
-- here.
--
-- `security/authentication.md` §6 says a token of a given purpose is "invalidated
-- by use or by a newer token". Until this index, the only thing holding that was
-- `TokenService.issue`: an advisory lock on `hashtext('vtk:<userId>:<purpose>')`,
-- a supersede of every row with `consumedAt IS NULL`, and an insert, all in one
-- transaction. That is correct and it is *application* correctness — a writer
-- that inserts into `VerificationToken` without going through that method
-- reintroduces the defect silently, because `@@index([userId, purpose])` is not
-- unique and the database arbitrates nothing.
--
-- Hand-written because Prisma cannot express a partial index in
-- `schema.prisma` and does not see one in either direction (carry-forward ruling
-- 4): it will not create it, and it will not offer to drop it. **Do not "restore"
-- a plain `@@unique([userId, purpose])` in the schema** — that would forbid a
-- user from ever holding two tokens of the same purpose across their whole
-- history, including consumed ones.
--
-- WHAT THIS COSTS IF IT FIRES. The loser of a race becomes a Prisma P2002 that a
-- caller would have to catch. It should never fire for `TokenService.issue`,
-- because the advisory lock serialises the supersede-then-insert pair for one
-- (userId, purpose) — and that is asserted rather than assumed, by the
-- concurrent-issue case in `token.service.integration.spec.ts`.
--
-- This migration is sound on its own: it adds one index and touches nothing else.
-- On a database already holding two live tokens for one pair it would fail rather
-- than corrupt anything, which is the correct direction for an invariant.

-- CreateIndex (hand-written: not expressible in schema.prisma)
CREATE UNIQUE INDEX "VerificationToken_userId_purpose_live_key"
  ON "VerificationToken" ("userId", "purpose")
  WHERE "consumedAt" IS NULL;
```

---

## 3. Verification

Run on the finished tree at `abcb47c`. Every exit code captured outside a pipe
(`out=$(...) 2>&1; code=$?`).

| Command | Exit | Output figures |
|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm lint` | 0 | 14 tasks successful |
| `pnpm typecheck` | 0 | 14 tasks successful |
| `pnpm test` | 0 | 73 files, **1085 tests** passed |
| `pnpm check:specs` | 0 | `90 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | 0 | 17 files, **229 tests** passed, 80.23s |
| `pnpm build` | 0 | 8 tasks successful |
| `pnpm check:openapi` | 0 | **`routes: 7`**, `apps/api/openapi.json is byte-identical to what the contracts generate` |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` |
| `pnpm check:secrets` | 0 | `365 tracked files, no credential-shaped literals` |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit — all `Up (healthy)` |

`lint` and `typecheck` were turbo cache hits in that run. Re-run forced:

```
pnpm exec turbo run lint typecheck --force   ->  exit 0, "22 successful, 22 total, Cached: 0"
```

For the record, the same table one commit earlier: **`pnpm lint` exit 1 and `pnpm typecheck` exit 2
while `pnpm test` was exit 0** — carry-forward ruling 40, and I hit it. See finding F2.

`pnpm db:migrate` exit 0; both migrations applied. `pnpm db:reset` was not run and cannot be
(carry-forward ruling 3).

---

## 4. Mutations

Twelve mutations, written by me, applied to the **implementation** and never to a test. Each was
applied, the suite run, then reverted. Every one was killed.

| # | Mutation | Killed by |
|---|---|---|
| M1 | Skip the Argon2id hash on the existing-address registration path | unit — `pays for the Argon2id hash anyway`. **Survived the integration lane.** |
| M2 | Send the verification mail *inside* the transaction | unit — `sends NOTHING when the transaction fails after the writes` |
| M3 | Drop the `User.status` check after `consume` (ruling 37) | **integration only** — `refuses a LOCKED account and leaves the token unconsumed`. Survived the whole unit lane. |
| M4 | Resend for an already-verified account sends anyway | unit — `does nothing for an address that is already verified` |
| M5 | Propagate a send failure to the caller | unit — 2 tests, one per endpoint |
| M6 | Put the **raw** verification token in the audit event's metadata | unit — `puts no raw token, password or address in the audit event`, **but only after I fixed that test; see below** |
| M7 | Widen the unique-violation catch to swallow every error | unit — 2 tests |
| M8 | Gate reads `getHandler()` only, dropping class-level metadata | unit — **6** tests, all of them the class-level and inherited cases (ruling 61) |
| M9 | Registration writes no audit event | unit — 2 tests |
| M10 | Existing-address path returns before sending the notice | unit — 4 tests |
| M11 | `emailVerifiedAt` stamped from a fresh clock reading, not the consume instant | **integration only** — `stamps emailVerifiedAt, consumes the token, and audits it`. Survived the whole unit lane. |
| M12 | Gate admits a request with no principal | unit — 3 tests |

**Two survivors on the first pass, and one of them was a test defect rather than a code defect.**

1. **M6 survived the unit lane.** `puts no raw token, password or address in the audit event`
   searched the serialised event for the token **hash**, which is the only form the unit fake ever
   sees — so a mutant that inserted the **raw** token had nothing to match against. Fixed by
   asserting the exact metadata key set instead of substring-searching for a value the spec cannot
   see. The same fix went into the resend's equivalent assertion. Commit `9039e61`.
2. **M1 survives the integration lane** and is killed only by the unit lane. That is expected and
   stated rather than hidden: the integration suite contains no timing assertion, deliberately (§5).

M3 and M11 are killed only by the integration lane, which is the division the specs' own docblocks
claim: the accepting redemption path depends on an `UPDATE`'s affected-row count against a real row,
and a fake makes it true by construction.

### Ruling E — the enumeration test broken deliberately

I made `RegistrationService.register` throw a 409 `DUPLICATE_RESOURCE` on the existing-address path,
then ran the enumeration spec. Failing output, with ANSI stripped:

```
   × POST /auth/register answers identically for a new and an existing address > is byte-identical in status, headers and body 222ms
     → expected 409 to be 200 // Object.is equality
   ✓ POST /auth/register answers identically for a new and an existing address > the two paths really did do different things 104ms
   × POST /auth/register answers identically for a new and an existing address > answers the same way whether the existing account is verified or not 219ms
     → expected Buffer[ 123, 34, 101, 114, 114, …(9) ] to deeply equal Buffer[ 123, 34, 101, 114, 114, …(9) ]
   × POST /auth/register answers identically for a new and an existing address > answers the same way for a LOCKED account 173ms
     → expected 409 to be 200 // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```

Reverted; the same command then reported `Tests 8 passed (8)`, exit 0.

**One honest caveat about that run.** The third failure — `answers the same way whether the existing
account is verified or not` — compares two accounts that *both* exist, so under this mutant both
returned 409 and the byte comparison failed only because the two error envelopes carry different
`requestId` values. That test failed for an incidental reason, not because it detected the oracle.
The first and fourth failures are the real kills.

---

## 5. Measurements, and which claims are readings rather than measurements

### The timing residual — measured, and the resend's is a working oracle

Measured through the real application (Testcontainers Postgres, compose Redis, recording mailer),
25 samples per case after 5 warm-up rounds, rate-limit windows cleared **outside** the timed region.
Windows 11 x64, Node v26.7.0. The measuring spec was temporary and is not committed.

```
register  NEW address     : n=25 median=47.8ms mean=47.8ms min=41.4ms max=57.6ms
register  EXISTING address: n=25 median=44.5ms mean=44.9ms min=37.9ms max=56.7ms
resend    NO account      : n=25 median= 4.0ms mean= 4.1ms min= 3.6ms max= 4.9ms
resend    UNVERIFIED      : n=25 median= 8.6ms mean= 9.1ms min= 7.7ms max=12.4ms
resend    ALREADY VERIFIED: n=25 median= 4.2ms mean= 4.4ms min= 3.6ms max= 5.9ms
```

**Registration.** 3.3 ms of median difference on ~46 ms, with ranges that overlap almost entirely.
The brief asked me to say with a measurement whether a statistical timing assertion is worth its
flake risk: **it is not.** Separating those two distributions needs a large, quiet sample, which is
exactly the shape of assertion carry-forward ruling 49 warns about. The committed assertion is
instead that `PasswordService.hash` **is called** on both paths — a behavioural fact with no
scheduling dependence, and M1 confirms it kills the mutation that matters.

**The resend is a different story and it is a real finding.** The three cases' ranges do **not
overlap**: 3.6–4.9, 7.7–12.4, 3.6–5.9. Any single response over about 7 ms is the
awaiting-confirmation case. The response is byte-identical and the latency is not, so
`POST /auth/resend-verification` **is enumerable by timing** as shipped. And these figures use a
recording mailer with no network at all — a real SMTP relay makes the gap larger. Closing it means
moving the send off the response path, which needs the Phase 4 queue (ADR-0016, carry-forward
ruling 45). Recorded in `security/authentication.md` §6 and in the service's docblock. **Nothing in
this task closes it, and no document should call that endpoint enumeration-resistant without the
qualification.**

### ADR-0019's RLS measurement — re-run, and it reproduces

The brief said the ADR's measurement was fair game to contradict. I re-ran it against the compose
Postgres on 2026-08-28, on a fresh scratch table carrying the exact policy, as `sentinel_app`:

```
INSERT 0 1
             result
---------------------------------
 tenant-scoped insert: SUCCEEDED
(1 row)
ERROR:  new row violates row-level security policy for table "Adr19Probe"
```

The ADR is correct. Probe table dropped afterwards; `pg_class` confirms it is gone.

### Ruling C — the partial index verified, not assumed

Three integration cases in `token.service.integration.spec.ts`:

- the index exists, read out of `pg_indexes` (`UNIQUE`, `WHERE ("consumedAt" IS NULL)`);
- it **does** refuse a second live row inserted around `TokenService`;
- it **never** fires for `TokenService.issue` — ten rounds of four concurrent callers, every
  `Promise.allSettled` rejection list asserted empty.

So the answer to ruling C's question is: it cannot fire on the normal path, `TokenService`'s contract
does not change, and no caller has to catch P2002 for it.

### Ruling G — the resend does invalidate the earlier link

`invalidates the previous link — the property that makes a resend safe` registers, resends, then
submits the **first** link and requires `TOKEN_INVALID`, then submits the second and requires 200.
Three consecutive resends leave exactly one live token.

### Readings I did not measure

Stated as readings, not measurements:

- **I did not measure the effect of the trigger-function replacement on `AuditEvent`'s error
  message.** I read the SQL and grepped for the old literal. I did not run an `UPDATE` against
  `AuditEvent` to see the new text. `rls.integration.spec.ts` asserts the update *rejects* and not
  what it says, and it passes.
- **I did not measure whether `emailVerificationConsume`'s 30/hour is the right figure.** It is a
  judgement recorded with its argument in the config and in `abuse-prevention.md` §1. The only thing
  measured is that the class is fail-closed and per-IP-only.
- **I did not exercise these endpoints in a browser.** No `apps/web` screen exists (Task 16), and the
  verification link points at `/verify-email`, a route that does not exist yet. Expected, per the
  brief's "What you are not building".
- **I did not verify these routes against the compose database through a running `pnpm dev`.** Task
  7's ledger records that the compose Postgres has drifted —
  `has_schema_privilege('sentinel_app','public','USAGE')` returns `f` — so a real application run
  answers 500 from anything touching the database. I did not change anything on the operator's
  machine. Every integration spec uses its own Testcontainers Postgres and is unaffected.

---

## 6. Rulings in the brief I found to be false or imprecise

**None of the seven rulings A–G is false.** Every mechanism each of them asserts exists, was checked,
and behaved as described. Three smaller inaccuracies:

1. **`UserStatus` has no `SUSPENDED`.** The brief's "The behaviour" section says "a `LOCKED` or
   `SUSPENDED` user's verification token still redeems", and carry-forward ruling 37 says "a `LOCKED`
   or suspended user's". `enum UserStatus` in `schema.prisma` is `ACTIVE | LOCKED | DISABLED`;
   `SUSPENDED` belongs to `OrganizationStatus`. The check I built is `status !== 'ACTIVE'`, which
   covers both real arms, and the specs cover `LOCKED` and `DISABLED` by name. Cosmetic, but it is
   the class of thing this project asks me to report.
2. **Ruling A says to add the id prefix to "both registries".** `packages/contracts/src/ids.ts` is
   the *client-facing* prefix map, and every entry in it produces an `*IdSchema` the API validates
   requests against. `AuditEvent`'s `aud` is deliberately **not** there — it sits in
   `id-prefix-parity.spec.ts`'s `DB_ONLY_PREFIXES` with the reason "the audit query API is Phase 3;
   no contract addresses one yet". Giving `PlatformAuditEvent` a contract schema while its sibling
   has none would be an inconsistency nothing in the API can act on, so I used the allowlist —
   which the parity spec's own docblock names as the sanctioned alternative ("adding a prefix here
   means adding a schema there, **or** adding an explicit reason to that spec's `DB_ONLY_PREFIXES`
   allowlist"). This is a deliberate deviation from the brief's wording; the orchestrator should
   overrule it if the intent was literal. **Finding F1.**
3. **Ruling F says the gate should be proved "through `apps/api/src/testing/routing-app.ts`".** It
   is — via `buildGuardedApp`, not `buildRoutingApp`, because a guard's observable behaviour is a
   status code and an error envelope and that needs the global exception filter. Both live in that
   file; the brief named the file, so this is a clarification rather than a correction.

---

## 7. Findings from my own work

**F1 — the id-prefix deviation.** §6.2. Deliberate, argued, and the orchestrator's to overrule.

**F2 — `pnpm lint` and `pnpm typecheck` were both red while `pnpm test` was green, on my own
branch, and I nearly did not notice.** I had been running targeted spec files. Two real defects were
hiding there: the two new test-support files sat outside `eslint.config.js`'s harness exemption
(so `@sentinel/db/testing`, `@sentinel/db/unscoped` and `process.env` were all restricted-import
errors), and `IdentityStore` is not assignable to `VerificationTokenStore` because its
`$transaction` hands the callback a *subtype* — a TS2345 that no test could see. Carry-forward
ruling 40 exactly. Fixed in `abcb47c` by moving the files into `apps/api/src/testing/` — **not** by
widening the lint fence, which is the change a reviewer should check I did not make.

**F3 — `auth.module.spec.ts`'s `registers no controller` was red on this branch and I found it
through a mutation run, not through running the suite.** That test was the check holding the
"four routes" property through Task 7. Task 8 makes it false by design, and it should have been the
first test I updated. It now asserts the exact controller list. Same root cause as F2.

**F4 — the published OpenAPI document describes no request bodies.** `ApiDocDeclaration` has a
`responses` array and no `requestBody`, so the three new operations publish their response schemas
and say nothing about what a client should send — even though `registerRequestSchema` and the other
two are the schemas the routes validate against. This is a pre-existing limitation of
`openapi/generate.ts` that Task 8 is the first to make visible, because Task 8 ships the first
routes that *take* a body. I did not fix it: it changes the document shape for every route and is a
decision, not an oversight to patch quietly. `pnpm check:openapi` reports 7 routes either way.

**F5 — the resend timing oracle.** §5. The strongest finding in this task and it is not closable
in Phase 2.

**F6 — a verification failure writes no audit event, deliberately.** `security/audit.md` §3 says
failures and denials are audited. `TOKEN_INVALID` on `verify-email` writes nothing, because the
endpoint does not know which account a bad token was aimed at (the row was never found) and because
an unauthenticated caller could otherwise append 30 rows an hour per IP to an append-only table.
`REGISTRATION_BLOCKED_EXISTING_EMAIL` is the failure that *is* audited, because there the account is
known. I made this call; it is not in the brief.

**F7 — my mutation script's `git checkout -- apps/api/src` destroyed uncommitted spec fixes once,
and I had to redo them.** Recorded because the same script is the obvious thing for a reviewer to
reuse. It reverts the whole of `apps/api/src` after each mutant.

---

## 8. Design decisions I made that the brief did not

- **`TokenService` gained `issueInTransaction` and `consumeInTransaction`.** Prisma interactive
  transactions do not nest, so "all database work in one transaction" was unreachable while `issue`
  opened its own. `issue`/`consume` are now thin wrappers over the new methods, so every property
  their existing specs pin is the same code rather than a second copy, and those specs stayed green
  through the change. The brief said `TokenService` "is not your file" in the narrower context of
  ruling C's P2002 question; I read that as scoped to that question, but it is a shared file and the
  orchestrator should know I touched it.
- **A refused verification is rolled back rather than burned.** A `LOCKED` account's link stays live,
  so an unlock makes it usable again. The alternative destroys a credential in exchange for nothing,
  since the refusal is identical either way and the route is rate limited per IP. Asserted both ways
  in the integration spec.
- **A send failure never reaches the caller.** Propagating it would make a mail-transport outcome
  into an existence signal — on the resend directly, and on registration for any address whose
  message a relay happens to reject. The cost is ADR-0016's known gap, and it is why the resend
  endpoint is in this task.
- **The P2002 race is folded into the existing-address path.** Two requests registering the same new
  address at once: the loser would otherwise get a 500 where the winner got a 200, on identical
  input. It is treated exactly as if the address had already existed, which by then it has.
- **`REGISTRATION_BLOCKED_EXISTING_EMAIL` carries `actorType: 'SYSTEM'` and a null actor.**
  `ActorType` has no anonymous arm, and naming the existing user as the actor would be a false
  statement in an append-only table — the point of the row is that it was probably not them.
- **The rate-limit class is named `emailVerificationConsume`**, matching this codebase's word for
  redeeming a token, and the `abuse-prevention.md` §1 row reads "Email verification submit".
- **The `EmailVerifiedGuard` is registered in no module.** `app.module.spec.ts` asserts "exactly
  three global guards" and says a fourth is Task 12's decision. Registering it would have taken that
  decision and edited Task 7's spec. Instead there is an assertion in
  `email-verified.guard.spec.ts` that it appears in no `APP_GUARD` provider, so ruling F's claim is a
  test rather than a sentence, and it goes red the day someone registers it without applying it.

---

## 9. What is incomplete or uncertain

- **The gate governs zero routes.** By design (ruling F), and asserted. `EMAIL_NOT_VERIFIED` cannot
  be produced by any real request today. Task 13.
- **The resend is enumerable by timing.** F5. Not closable in Phase 2.
- **The verification link points at `/verify-email`, which does not exist.** Task 16. Expected.
- **No request bodies in the OpenAPI document.** F4.
- **Nothing has run in CI.** Tasks 6, 7 and now 8 are three unpushed branches with no pull request.
  Everything above was measured on this machine only.
- **`roadmap.md` still says "4 routes" in eleven places**, including line 17, which is its
  current-status row for Phase 2. I did not edit it — the orchestrator owns it. The ten other
  occurrences are inside dated per-task evidence tables and are historically correct; **line 17 is
  the one that is now false.**
- **I did not re-verify Task 7 beyond running its suites.** The execution protocol asks a session to
  verify the previous task only; Task 7's specs all pass inside the runs in §3, and I did not
  independently re-derive its evidence table.
- **The compose Postgres drift recorded by Task 7 is still there.** I did not fix it and did not
  change anything on the operator's machine.
