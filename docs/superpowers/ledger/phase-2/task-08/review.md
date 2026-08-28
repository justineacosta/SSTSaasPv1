# Phase 2 · Task 8 — adversarial review

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-28. Written by a fresh reviewer who did not write this code. Range reviewed:
`a39f4b3..HEAD` on `feat/phase-2-task-08`. Nothing was fixed and nothing was pushed; findings only.
Every mutation below was applied to the **implementation**, never to a test, and every one was
reverted — `git status --porcelain` is empty and `packages/db/prisma/schema.prisma` was never
touched, so carry-forward ruling 39 does not apply.

**One High.** It is a live behaviour, not a missing test: an unauthenticated caller can put
attacker-chosen text — including a URL — into a security notice this product mails to any address
that already has an account, and the registry spec that asserts "no link of any kind" cannot see it
because every fixture is benign. That is carry-forward ruling 58 for the third time in three tasks.

---

## Pass 0 — verification, re-run

All eleven re-run by me on `7c31ea0`, exit code captured outside a pipe.

| Command | Exit | Output figures | Matches orchestrator? |
|---|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | yes |
| `pnpm lint` | 0 | 14 tasks successful | yes |
| `pnpm typecheck` | 0 | 14 tasks successful | yes |
| `pnpm test` | 0 | `Test Files 73 passed (73)` / `Tests 1085 passed (1085)` | yes |
| `pnpm check:specs` | 0 | `90 spec files, each claimed by exactly one of: unit, integration, ui` | yes |
| `pnpm test:integration` | 0 | `Test Files 17 passed (17)` / `Tests 229 passed (229)`, 79.74s | yes |
| `pnpm build` | 0 | 8 tasks successful | yes |
| `pnpm check:openapi` | 0 | `"routes":7`, `byte-identical to what the contracts generate` | yes |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` | yes |
| `pnpm check:secrets` | 0 | `365 tracked files, no credential-shaped literals` | yes |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit — all `Up (healthy)` | yes |

**No figure differs from the orchestrator's.** Per-file spec counts in the report's §1 also check
out exactly: `email-verified.guard.spec.ts` 16, `platform-audit.service.spec.ts` 7,
`registration.service.spec.ts` 15, `email-verification.service.spec.ts` 11,
`auth.enumeration.integration.spec.ts` 8, `auth.verification.integration.spec.ts` 13,
`token.service.integration.spec.ts` 18 (was 15), `auth.module.spec.ts` 8 (was 6),
`registry.spec.ts` 76.

Commit/diff arithmetic also checks out. `a39f4b3..abcb47c` is 11 commits / 43 files (the report's
figure), `a39f4b3..75e4017` is 12 commits / 44 files / +5035/−93 (the review brief's figure), and
`a39f4b3..HEAD` is now 13 / 45 / +5182/−93 because the range includes the two ledger commits.

---

## The two orchestrator claims that were in scope

### Claim 1 — ADR-0019's RLS measurement. **REPRODUCED. The ADR is correct.**

Fresh scratch table carrying `AuditEvent`'s exact policy, on the compose Postgres, as
`sentinel_app`:

```
 current_user
--------------
 sentinel_app
(1 row)

SET
INSERT 0 1
             result
---------------------------------
 tenant-scoped insert: SUCCEEDED
(1 row)

ERROR:  new row violates row-level security policy for table "Rev19Probe"
```

Probe table dropped; `SELECT count(*) FROM pg_class WHERE relname='Rev19Probe'` returns 0. The ADR's
central premise — that relaxing `organizationId` to nullable would not on its own make the write
work — holds.

### Claim 2 — ruling D's chain. **TRUE at every link.**

- `rate-limit.guard.ts:249` is literally `]) ?? 'generalSession';` — a route with no class does fall
  to `generalSession`.
- `rate-limit.config.ts:147-151`: `generalSession` is `perPrincipal` + `principalSource:
  'authenticated'` + `failMode: 'open'`. One scope, unresolvable before authentication.
- Nothing warns. The `unresolvedWarned` warn at `rate-limit.guard.ts:346` is guarded by
  `unresolved.length > 0 && decisions.length > 0 && config.failMode === 'closed'` — fails on two
  counts for `generalSession`. The surviving line is `rate-limit.guard.ts:368`,
  `else this.logger.debug(bindings, message)`, which `LOG_LEVEL=info` does not emit.

Ruling 55 was right and the brief transcribed it correctly. **But see finding M1: nothing in the
suite would notice if a route silently fell into that state.**

---

## Findings

### H1 — an unauthenticated caller injects attacker-chosen text into a security notice sent to a third party, and the spec that would catch it is vacuous

**Severity: High, for a live control.** Not a missing test over correct code — a behaviour that
ships. `POST /api/v1/auth/register` against an address that already has an account mails
`registrationAttempt` to the account owner. `request-context.ts:41` takes the caller's `User-Agent`
header verbatim (512 chars), `registration.service.ts` passes it to `AuthMailer`, and
`notice.templates.ts:41` renders it as `Device: <value>` in both parts of the message. The value is
HTML-escaped, so this is not XSS — it is content injection into a message the recipient reads as a
genuine Sentinel security notice, from Sentinel's sending domain, whose own footer says Sentinel
*"never includes a link in a security notice like this one"*.

**Proof.** Rendered through the built template with a hostile agent string:

```
$ node -e "import('./dist/modules/auth/emails/notice.templates.js').then(m => { ... })"
--- TEXT PART ---
Someone tried to create a Sentinel account with your email address
...
Device: Mozilla/5.0 -- URGENT: verify at https://sentinel-support.example/verify?t=abc

--
If this was not you, no action is needed. No account was created and your existing account is unchanged.
Sentinel will never ask you for your password or a code by email or phone, and never includes a link in a security notice like this one.

--- HTML contains https: true
```

Mail clients autolink a bare URL in `text/plain`, so the last two lines of that message contradict
each other in the recipient's inbox.

**Why the suite cannot see it — carry-forward ruling 58, third instance.**
`registry.spec.ts:277` is the assertion that would catch it:

```ts
it('carries no link of any kind, in either part', () => {
  const email = SAMPLES(id);          // <- BENIGN fixture
  expect(email.html).not.toMatch(/https?:\/\//);
```

`SAMPLES` uses `BENIGN`, whose `userAgent` is `'Mozilla/5.0 (X11; Linux x86_64)'`. The `HOSTILE`
fixture exists two declarations away and is used only by the escaping test — and its payload
`<script>alert(1)</script>" onmouseover="steal()` contains no `http`, so even swapping `ATTACKED`
in would not fail. **Every fixture for the "no link" property sits on the harmless side of the
branch under test**, which is exactly what ruling 58 says to check before believing a fix.

**Bounds, stated so the orchestrator can downgrade with full information.** One line, HTML-escaped,
capped at 512 characters, prefixed with `Device: `, and rate limited at 3/hour per IP (measured —
see M1's proof, `200,200,200,429,429`). What it buys is a bounded but real outbound-mail channel to
any address the attacker can guess is registered, wearing the product's own branding. Task 8 is what
makes it reachable: before this branch there were no routes at all, and every other notice template
is triggered only by an action inside an authenticated session.

---

### M1 — the rate-limit class on all three shipped routes is asserted by nothing; downgrading all three to fail-open `generalSession` passes the entire eleven-command gate

**Severity: Medium, for assurance of an abuse control — not for a control that fails today.** I
measured that `registration`'s 3/hour per IP *is* live (see below). What is missing is anything that
would notice if it stopped being, and ruling D is the ruling that says exactly what happens then:
"the default is not a weak limit, it is no limit and no signal."

**Mutation R12b.** All three `@RateLimit(...)` classes on `auth.controller.ts` replaced with
`@RateLimit('generalSession')` — fail-open, one unresolvable scope, and a `debug` line the default
log level drops:

```
3 routes now generalSession
LINT EXIT=0
TYPECHECK EXIT=0
TEST EXIT=0
      Tests  1085 passed (1085)
CHECK:OPENAPI EXIT=0
INTEGRATION EXIT=0
 Test Files  17 passed (17)
      Tests  229 passed (229)
```

**Mutation R12**, deleting the three decorators outright, and **R11**, deleting only
`@RateLimit('emailVerificationConsume')` from `verify-email`, both survive the unit lane (1085
passed) and the three auth integration specs (39 passed) as well.

`rate-limit.config.spec.ts` asserts the *table*, value by value, and `rate-limit.integration.spec.ts`
exercises a purpose-built fixture controller — the same shape carry-forward ruling 58 warns about.
Nothing reads `RATE_LIMIT_METADATA_KEY` off `AuthController`'s three handlers.

**The control is live today, measured** (temporary probe spec through the real app, deleted after
the run):

```
PROBE register statuses over 5 calls in one window: 200,200,200,429,429
```

---

### M2 — `verify-email`'s `User.status` check has an arm no test covers, and the report says otherwise

**Severity: Medium, for carry-forward ruling 37 — a check this task was explicitly bound to build.**

**Mutation R3**, `email-verification.service.ts:107`:

```
WAS: "      if (user.status !== ACTIVE_USER_STATUS) throw new TokenInvalidError();"
NOW: "      if (user.status === 'LOCKED') throw new TokenInvalidError();"
R3 unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

A `DISABLED` account's verification link redeems, and nothing goes red. `grep` confirms why: the only
`DISABLED` fixture in the auth specs is `email-verification.service.spec.ts:179`, `does nothing for a
DISABLED account`, which covers **`resend`**. The `verify` path has one status test,
`auth.verification.integration.spec.ts:218`, `refuses a LOCKED account and leaves the token
unconsumed`.

The report's §6.1 says: *"The check I built is `status !== 'ACTIVE'`, which covers both real arms,
and the specs cover `LOCKED` and `DISABLED` by name."* True of `resend`; **not true of `verify`**,
which is the path ruling 37 named.

---

### M3 — two new code comments cite spec files that do not exist

**Severity: Medium, as prose — this project's dominant defect class, and a citation `grep` settles.**

```
$ grep -rn "platform-audit.integration.spec\|platform-audit.actions.spec" apps/api/src
apps/api/src/modules/audit/platform-audit.actions.ts:7: * transcription, and `platform-audit.actions.spec.ts` asserts they agree.
apps/api/src/modules/audit/platform-audit.service.ts:43:   * `platform-audit.integration.spec.ts` asserts it for the events this task

$ ls apps/api/src/modules/audit/
audit.module.ts  platform-audit.actions.ts  platform-audit.service.spec.ts  platform-audit.service.ts
```

Neither file exists anywhere in the repository. Both assertions *are* made — the taxonomy parity test
is `platform-audit.service.spec.ts:655`, and the no-raw-token check is
`auth.verification.integration.spec.ts:91` — so the substance is sound and only the names are wrong.
That is precisely the shape of the Task 7 defect that produced ruling 55.

---

### M4 — the report and the migration comment both say the `AuditEvent` trigger message changes. Measured: it does not change at all

**Severity: Medium, as prose.** The report's §2 says, in bold, *"One statement in that file changes
existing behaviour and the operator should look at it specifically"*, and then: *"`AuditEvent`'s two
triggers keep pointing at the same function, so **their message text changes**."* The migration file
says the same more softly: *"their behaviour is unchanged apart from the table name in the message."*

The implementer disclosed honestly that this was a reading, not a measurement. I measured it. Phase 1
raised `'AuditEvent is append-only: % is not permitted'`; Task 8 raises
`'% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP`. On `AuditEvent`, `TG_TABLE_NAME` *is*
`AuditEvent`, so the rendered text is byte-identical:

```
$ docker compose exec -T postgres psql -U sentinel -d sentinel
BEGIN
...
ERROR:  AuditEvent is append-only: UPDATE is not permitted
CONTEXT:  PL/pgSQL function audit_event_is_append_only() line 3 at RAISE
ROLLBACK
ERROR:  PlatformAuditEvent is append-only: UPDATE is not permitted
CONTEXT:  PL/pgSQL function audit_event_is_append_only() line 3 at RAISE
ROLLBACK
ERROR:  AuditEvent is append-only: DELETE is not permitted
CONTEXT:  PL/pgSQL function audit_event_is_append_only() line 3 at RAISE
ROLLBACK
```

`AuditEvent`'s observable behaviour is unchanged in every respect, including the message. The
`CREATE OR REPLACE` was the right move and the sentence describing it is false.

**The brief's harder question — what if the migration half-applies — has a clean answer.** The
replacement body raises unconditionally, exactly as the original did, so at *every prefix* of that
file `AuditEvent`'s two triggers still refuse every `UPDATE` and `DELETE`. There is no prefix at
which its tamper resistance is weaker. A second function would have bought nothing here.

The report also says the old literal *"appears in this migration, in the Phase 1 migration, and in
two ledger and plan documents"*. `grep` finds it in **three**:
`docs/superpowers/ledger/phase-1/review-diffs/review-0990cbb..17989c8.diff:142`,
`docs/superpowers/ledger/phase-1/task-06/brief.md:569`, and
`docs/superpowers/plans/2026-08-20-phase-1-foundation.md:3010`. The load-bearing half — **no spec
asserts it** — is correct.

---

### M5 — `roadmap.md` still says the API publishes four routes

**Severity: Medium, for the file `CLAUDE.md` calls the single source of truth for status.**

```
$ grep -n "4 routes" .claude/product/roadmap.md | head -1
17:| 2 | Identity | **Not Implemented** — Tasks 1–7 of 18 done 2026-08-27 (... the mailer with seven
templates ...); the API still publishes **4 routes**, so nothing authenticates anybody and no email
has a caller |
```

`pnpm check:openapi` reports 7. Line 17 is the current-status row, not a dated evidence table, and
the same row also carries the now-false "seven templates". The implementer flagged this in §9 and
correctly did not edit it. It is still false in the range under review, and `CLAUDE.md` requires the
roadmap to move in the same change that moves the status.

---

### M6 — six "seven templates" statements are now false, one of them in a `.claude/` document

**Severity: Medium for the `.claude/` one (documentation rule), Low for the code comments.**

```
$ grep -rn "seven templates\|four carry none" --include=*.ts --include=*.md apps/api/src .claude/
.claude/architecture/integrations.md:112:  The seven templates are `apps/api/src/modules/auth/emails/`, behind a registry.
apps/api/src/infrastructure/mail/smtp-mailer.ts:16:      the seven templates put a live single-use credential in their body
apps/api/src/infrastructure/mail/mail.redaction.spec.ts:15:  Three of the seven templates put a live single-use credential in their body,
apps/api/src/modules/auth/emails/escape-html.spec.ts:13:  three of the seven templates address the recipient by it.
apps/api/src/modules/auth/emails/registry.spec.ts:141:    // Three carry a live credential and four carry none.
apps/api/src/app.module.ts:41:    // Task 5 ships the port, the adapter and seven templates for Tasks 8, 10, 11 and 15
```

There are eight, and `NOTICE_TEMPLATE_IDS` now has five members. `app.module.ts:41` is the one
acceptable survivor — it is a statement about what Task 5 shipped and is still true. The other five
are present-tense and false. `integrations.md:112` is the one `CLAUDE.md`'s documentation rule
required this change to update; `registry.spec.ts:141` is in a file the implementer edited in this
very task. Task 8 did update `notice.templates.ts`'s own header from "The three messages" to "The
messages", so the count problem was noticed in one file and not swept.

---

### M7 — `token-invalid.error.ts`'s docblock was made false by this task and not updated

**Severity: Medium, as prose about a security control.** Two sentences (`token-invalid.error.ts:19`
and `:26`):

> "The forensic record of *which* it was belongs in the `AuditEvent` the endpoint writes, where only
> an operator sees it."
> "Nothing raises this yet: Task 4 ships no endpoint."

Both are now false. `EmailVerificationService.verify` raises `TokenInvalidError` on four distinct
paths, and — per the implementer's own F6, a deliberate decision — **the endpoint writes no audit
event on a verification failure at all**. So the file promises a forensic record that this task
decided not to create, and names the wrong table for it besides (it would be `PlatformAuditEvent`).
This is the same category of staleness the implementer correctly fixed in `token.service.ts`'s
"partial index is deliberately not here" docblock, missed in the sibling file.

---

### M8 — the published OpenAPI document describes no request body for any of the three routes

**Severity: Medium, for a shipped contract.** Confirming the implementer's own F4 rather than taking
it:

```
$ node -e "const d=require('./apps/api/openapi.json'); ..."
routes: 7
POST /api/v1/auth/register            requestBody? false  responses: 200,422,429,default
POST /api/v1/auth/resend-verification requestBody? false  responses: 200,429,default
POST /api/v1/auth/verify-email        requestBody? false  responses: 200,422,429,default
```

`ApiDocDeclaration` (`openapi.decorator.ts:41-45`) has `summary`, `description?`, `responses` and no
`requestBody`, and `grep -rn requestBody apps/api/src/openapi/` returns nothing. `check:openapi`
passes either way. The first three routes this product has ever published tell a client what they
answer and nothing about what to send — including that `email` is normalised, that `password` has a
12-character floor, and that the schemas are `.strict()` so an unknown key is a 400 `UNKNOWN_FIELD`.
Agreed with the implementer that this is a decision, not a patch.

---

### L1 — the 512-character user-agent bound is untested

**Severity: Low.** `request-context.ts:35` documents the bound as the thing that stops "an
unauthenticated caller writ[ing] a megabyte into an append-only table one request at a time".

**Mutation R6b**, widening it 10 000× while keeping the constant referenced so the compiler cannot
object:

```
NOW: "    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_MAX_LENGTH * 10_000) : null,"
TYPECHECK EXIT=0
LINT EXIT=0
R6b-seq unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

(Related to H1: the same value is what reaches the mailbox.)

---

### L2 — the audit row's IP can be switched to the client-chosen `X-Forwarded-For` with the whole suite green

**Severity: Low.** `request-context.ts:24-30` argues at length that reading `X-Forwarded-For` here
would be worse than recording nothing. **Mutation R7** does exactly that:

```
NOW: "    ip: (typeof request.headers['x-forwarded-for'] === 'string' ? request.headers['x-forwarded-for'] : request.ip) ?? null,"
R7 unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

An append-only audit table would then carry an attacker-chosen address, and nothing would say so.

---

### L3 — logging the rendered email body survives; only the redactor stops the token

**Severity: Low, and the second line of defence holds.** **Mutation R9** adds
`body: rendered.html, text: rendered.text` to `AuthMailer.deliver`'s warn bindings:

```
R9 unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

For `emailVerification` that body contains the raw `?token=` link. I then measured whether the
redactor catches it:

```
HTML has raw token: true
redact export? function
after redact, html still has raw token: false
```

So the mutant is a survivor over code the redaction pattern saves. Carry-forward ruling 47 records
the residual that pattern does *not* cover.

---

### L4 — `verify`'s fail-closed anomaly branch is untested and the mutant answers 200

**Severity: Low.** **Mutation R25**, `email-verification.service.ts:105`, turning
`if (user === null) throw new TokenInvalidError();` into a silent `return`:

```
R25 unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

The mutant answers `200 { status: 'EMAIL_VERIFIED' }` after consuming a token belonging to nobody.
Unreachable while the FK cascade holds; a survivor over correct code.

---

### L5 — the report misattributes a quotation

**Severity: Low, as prose.** Report §6.2 attributes *"adding a prefix here means adding a schema
there, **or** adding an explicit reason to that spec's `DB_ONLY_PREFIXES` allowlist"* to *"the parity
spec's own docblock"*.

```
$ grep -rn "adding a schema there" --include=*.ts .
./packages/db/src/id.ts:16
```

It is in `packages/db/src/id.ts`, not in `id-prefix-parity.spec.ts`, whose docblock says something
different (and compatible).

**The deviation itself is fine, and I tested it rather than accepting either the ruling or the
implementer's reasoning.** Adding a prefix to `id.ts` with no entry in either list:

```
$ node -e "... add zzz to ID_PREFIXES ..."
$ pnpm vitest run --project unit packages/db/src/id-prefix-parity.spec.ts
   × ID prefix parity between @sentinel/db and @sentinel/contracts > accounts for every db prefix — either a contract schema or an allowlisted reason 5ms
     → expected [ 'zzz' ] to deeply equal []
      Tests  1 failed | 3 passed (4)
```

The parity spec still fails when it should, so the allowlist is a recorded decision rather than an
escape hatch, and treating `pau` exactly like its sibling `aud` is the consistent choice. A
client-facing `platformAuditEventIdSchema` for a row no contract addresses would have been dead
weight. **Ruling A's "both registries" should be read as satisfied.**

---

### L6 — `api/authentication.md:163` cross-references the wrong §2

**Severity: Low, as prose.** *"§2's table gives 201 to a creation 'with `Location`'."* Inside
`api/authentication.md`, §2 is "Session flow" and has no status-code table. The quotation is correct
and belongs to `api/conventions.md` §2. The two code comments that make the same point
(`auth.controller.ts` and `registration.service.ts`) both name `api/conventions.md` §2 correctly.

---

### L7 — `EmailVerifiedGuard` selects `status` and never reads it

**Severity: Low.** `email-verified.guard.ts:20` types the lookup as
`Promise<{ emailVerifiedAt: Date | null; status: string } | null>` and `canActivate` reads only
`emailVerifiedAt`. Either the guard means to refuse a non-`ACTIVE` account (in which case the check is
missing, and `email-verification.service.ts` makes the case for it) or it does not (in which case the
column is dead weight that a future reader will assume is load-bearing). Task 13 inherits the
ambiguity.

---

### L8 — the two new auth integration specs flake when run in parallel; ruling 33's hazard is now wider

**Severity: Low — the sanctioned command is unaffected.** I found this by accident: my first
mutation runs used `pnpm vitest run --project integration <three files>` without
`--no-file-parallelism`. On a **clean tree**:

```
clean 3-file run 1 exit=0        Tests  39 passed (39)
clean 3-file run 2 exit=1        × ... > is byte-identical in status, headers and body
                                 Tests  1 failed | 38 passed (39)
clean 3-file run 3 exit=0        Tests  39 passed (39)
```

Sequentially, four consecutive runs pass. `pnpm test:integration` passes `--no-file-parallelism`
(root `package.json:20`), so the gate is not affected. But carry-forward ruling 33 says "do not
restore parallelism without namespacing the shared services first", and Task 8 adds **two more**
suites that share the compose Redis rate-limit namespace and clear it in `beforeEach` *and* inside
`post()`. The ledger records ruling 33 against two suites; it is now four, and this is not written
down anywhere.

This also cost me one false mutation result — R6b appeared killed on its first (parallel) run and
survived on re-run — which is worth recording for whoever reuses a mutation harness here.

---

### L9 — the registration-attempt footer can be swapped for the wrong-advice one with the suite green

**Severity: Low.** `notice.templates.ts` splits `NOTICE_FOOTER` specifically so the new template does
not tell a recipient to change a password when nothing changed, and the reason is written out at
length. **Mutation R14** restores `footer: NOTICE_FOOTER`:

```
R14 unit=0 integ=0
  unit:       Tests  1085 passed (1085)
  integ:       Tests  39 passed (39)
```

The distinction the code argues for is enforced by prose alone.

---

## Attacks I made that failed — the code was right

Recorded because an honest account of a failed attack is worth more than an inflated finding.

- **A case-varied resend bypass of the 3/hour per-account limit.** The rate limiter keys
  `perPrincipal` on the **raw** body field, before Zod's `.trim().toLowerCase()` runs, so I expected
  `Alice@Example.com` and `alice@example.com` to get separate buckets. They do not:
  `normaliseAccountIdentifier` (`rate-limit.guard.ts:101`) applies `NFKC().trim().toLowerCase()` and
  is pinned by `rate-limit.guard.spec.ts:111`. The comment above it says in as many words that it
  must stay identical to whatever the Phase 2 account lookup does. It does.
- **A stale session cookie 403-ing the three public routes (ruling 56).** Measured through the real
  application with `Cookie: __Host-session=<garbage>`:
  `register 200 {"status":"VERIFICATION_REQUIRED"}`, `verify-email 422 TOKEN_INVALID`,
  `resend-verification 200 {"status":"VERIFICATION_REQUIRED"}`. No 403 anywhere. Ruling 56 holds on
  what shipped, and the controller comment describing it is accurate.
- **A half-applied migration weakening `AuditEvent`.** See M4 — there is no prefix of that file at
  which it does.
- **The partial unique index firing on the normal path.** Ruling C's question is answered, and the
  answer is load-bearing: with the advisory lock removed (mutation R1) the index fires immediately
  with `Unique constraint failed on the fields: (userId,purpose)` at
  `token.service.ts:250`, and with the lock in place ten rounds of four concurrent callers produce
  no rejections. Both halves of the index's justification are real.
- **The transaction/rollback properties.** Mutation R23 (a refusal that commits the consumption
  instead of rolling it back) and mutation R8 (the audit event written outside the transaction) are
  both killed. Mutation R2 (dropping `consumedAt: null` and the expiry predicate from `consume`)
  kills 9 tests. Mutation R20 (`controllers: []`) kills 22. The core of this task is well pinned.
- **Every `.claude/` section number in new code and changed documents.** I checked each by heading:
  `security/authentication.md` §6 (the quoted table row is at line 214) and §7,
  `security/audit.md` §2, §3, §4, §5, §6, `api/conventions.md` §2 (the "Created, with `Location`"
  row is real), `api/errors.md` §3 and §4, `api/authentication.md` §6,
  `security/abuse-prevention.md` §1, `architecture/backend.md` §1. All correct except L6.
- **ADR-0019's "same fields as `AuditEvent` minus `organizationId`".** True, column for column
  (`schema.prisma:543-562` vs `587-603`).

---

## Mutation results — 17 mutants, 8 killed, 9 survived

All mine, all applied to the implementation, all reverted. Unit lane = `pnpm test` (1085). Integ lane
= the three auth integration specs (39) run with `--no-file-parallelism`, except where the full
`pnpm test:integration` is named.

| # | Mutation | Result |
|---|---|---|
| R1 | Advisory lock removed from `issueInTransaction` | **killed** — unit 4 failed, integ 2 failed (P2002 from the new index) |
| R2 | `consume` drops `consumedAt: null` and the expiry predicate | **killed** — unit 1, integ 8 |
| R3 | `verify`'s status check narrowed to `=== 'LOCKED'` | **SURVIVED** → M2 |
| R4 | `resend`'s status check removed | **killed** — unit 2, integ 1 |
| R5 | Breach check moved below the existence branch (a 422/200 oracle) | **killed** — unit 1, integ 1 |
| R6 | `userAgent.slice(...)` removed outright | **SURVIVED** unit+integ (superseded by R6b, which also survives typecheck) |
| R6b | User-agent bound widened 10 000× | **SURVIVED** — lint 0, typecheck 0, unit 1085, integ 39 → L1 |
| R7 | Audit `ip` taken from `X-Forwarded-For` | **SURVIVED** → L2 |
| R8 | Registration's audit event written outside the transaction | **killed** — unit 5; survived the integ lane |
| R9 | Rendered email body added to the send-failure log line | **SURVIVED** → L3 |
| R10 | `emailVerificationConsume` `failMode: 'open'` | **killed** — unit 1 |
| R11 | `@RateLimit('emailVerificationConsume')` deleted from `verify-email` | **SURVIVED** → M1 |
| R12 | All three `@RateLimit` decorators deleted | **SURVIVED** → M1 |
| R12b | All three routes downgraded to `generalSession` | **SURVIVED lint, typecheck, test, check:openapi and the full 229-test integration lane** → M1 |
| R14 | `registrationAttempt` restored to `NOTICE_FOOTER` | **SURVIVED** → L9 |
| R20 | `AuthModule` registers no controller | **killed** — unit 1, integ 21 |
| R23 | A refusal commits the token consumption instead of rolling it back | **killed** — unit 1, integ 1 |
| R25 | `user === null` returns instead of refusing | **SURVIVED** → L4 |

The survivors cluster in one place and it is worth naming: **the wiring between the controller and
the cross-cutting controls**. Six of the nine (R11, R12, R12b, R6b, R7, and H1's underlying gap) are
about a decorator, a header, or a bound that only the real route exercises, and every one of them is
covered by a spec that tests the *table* or a *fixture controller* rather than the shipped handler.

---

## What I could not check

- **Nothing has run in CI.** Three unpushed branches, no pull request. Every figure in this document
  and in the report was measured on this machine, on Windows, with one Node version.
- **I did not exercise anything in a browser**, and there is no `apps/web` screen to exercise. The
  verification link still points at `/verify-email`, which does not exist (Task 16).
- **I did not re-derive the implementer's timing figures.** Reproducing 25 samples × 5 cases through
  the real application would have cost more than it bought, and the direction of the disclosure —
  the implementer volunteering an open oracle in their own work — is not the kind of claim that
  usually needs adversarial checking. The *conclusion* is consistent with the code: only the
  awaiting-confirmation branch of `resend` writes a row and calls the mailer, and both other branches
  return after a single indexed `findUnique`. **Not re-measured, and it should be, before any
  document downstream of this one calls that endpoint enumeration-resistant.**
- **I did not run `pnpm test:e2e`** — no Playwright journey touches these routes yet.
- **I did not verify the compose Postgres drift** recorded by Task 7 beyond confirming that the
  application role's `REVOKE UPDATE, DELETE` on `PlatformAuditEvent` is in force
  (`ERROR: permission denied for table PlatformAuditEvent` as `sentinel_app`).
- **`pnpm db:reset` was not run** and cannot be (carry-forward ruling 3), so I could not confirm the
  two migrations replay from empty on this machine. `migration.integration.spec.ts` replays them in
  the integration lane and passes.
