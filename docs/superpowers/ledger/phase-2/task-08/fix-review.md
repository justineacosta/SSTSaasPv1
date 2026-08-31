# Phase 2 · Task 8 — adversarial review of the fix round

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-31. Written by a fresh reviewer who wrote none of this code and none of the fixes.
Scope: `4487515` (the H1 fix, never reviewed) plus the five fix-round commits `56665b2`, `d32bd0c`,
`6202f83`, `dea98cb`, `d3a43de`. Everything before `4487515` was reviewed in
[`review.md`](review.md) and is re-examined here only where a fix commit touched it.

Nothing was fixed and nothing was pushed. Every mutation below was applied to the
**implementation** (two exceptions are labelled as deliberate test-side probes) and every one was
reverted; `git status --porcelain` is empty and `packages/db/prisma/schema.prisma` was never
touched, so carry-forward ruling 39 does not apply. One temporary Postgres schema was created and
dropped — see F0's proof and M4 below.

---

## BLOCKING — one High. Do not merge this branch as it stands.

**H1 is not closed.** The fix removed the `userAgent`/`ipAddress` channel and left a second one
open in the same template, and the fix round *measured that channel failing and switched the
assertion off* with a rationale that is false. An unauthenticated caller can still put a URL into
the `registrationAttempt` security notice — the same message, under the same footer that promises
Sentinel "never includes a link in a security notice like this one".

Full finding and proof: **F1** below.

**Nothing else is High.** The other seven findings are two Mediums in prose (one of them a
carry-forward *ruling* that is measurably false, one a false count in `roadmap.md`), five Lows, and
a tooling observation. Seventeen of the eighteen original findings' fixes were re-tested by
re-applying the reviewer's own mutations and **all of them hold** — the fixes work; the problem is
what the round concluded around them.

---

## Pass 0 — verification, re-run by me

All eleven, on `d3a43de`, exit code captured outside a pipe
(`out=$(pnpm <cmd> 2>&1); code=$?`).

| Command | Exit | Output figures | Matches `fixes.md`? |
|---|---|---|---|
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` | yes |
| `pnpm lint` | 0 | 14 tasks successful | yes |
| `pnpm typecheck` | 0 | 14 tasks successful | yes |
| `pnpm test` | 0 | `Test Files 76 passed (76)` / `Tests 1125 passed (1125)` | yes |
| `pnpm check:specs` | 0 | `93 spec files, each claimed by exactly one of: unit, integration, ui` | yes |
| `pnpm test:integration` | 0 | `Test Files 17 passed (17)` / `Tests 230 passed (230)`, 88.92s | yes |
| `pnpm build` | 0 | 8 tasks successful | yes |
| `pnpm check:openapi` | 0 | `"routes":7`, `byte-identical to what the contracts generate` | yes |
| `pnpm check:registry` | 0 | `15 models, 3 tenant-owned, 1 tenant root, 11 deliberately global` | yes |
| `pnpm check:secrets` | 0 | `368 tracked files, no credential-shaped literals` | yes |
| `docker compose ps` | 0 | postgres, redis, minio, mailpit all `Up (healthy)` | yes |

**No figure differs.** `pnpm test` and `pnpm test:integration` were each re-run a second time after
all mutation work, both green at the same numbers, so the tree is byte-identical to `HEAD` and the
figures are not an artefact of my harness.

The roadmap's "up from" figures also check out against its own Task 7 table
(`roadmap.md:1169,1171`): 69 / 1025 and 15 / 205. Branch arithmetic checks out —
`git merge-base main feat/phase-2-task-08` is `a39f4b3`, which is `main`, and `git ls-remote origin
feat/phase-2-task-08` returns nothing, so "cut from `main` at `a39f4b3`, unpushed" is true. The two
CI runs the roadmap names are real and green:

```
$ gh run view 33088717123 --json conclusion,headBranch,displayTitle
{"conclusion":"success","displayTitle":"docs: Task 7 is done — …","headBranch":"main"}
$ gh run view 33088206506 --json conclusion,headBranch,displayTitle
{"conclusion":"success","displayTitle":"Phase 2 Task 7: the authentication stage, CSRF and CORS","headBranch":"feat/phase-2-task-07"}
```

---

## F0 — the orchestrator's four high-risk claims, checked one at a time

Three of the four are **true and reproduced**. One is **false and is finding F2**.

### M4 — `AuditEvent`'s trigger message is byte-identical. **REPRODUCED. TRUE.**

Both audit tables are empty on the compose database, so a row-level trigger cannot be made to fire
against them directly. A scratch schema carrying a table of the same *name* and the shipped
function proves `TG_TABLE_NAME` renders exactly the Phase 1 literal:

```
$ docker compose exec -T postgres psql -U sentinel -d sentinel
CREATE SCHEMA m4probe;
CREATE TABLE m4probe."AuditEvent"(id int);
CREATE TRIGGER t BEFORE UPDATE ON m4probe."AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
INSERT INTO m4probe."AuditEvent" VALUES (1);
UPDATE m4probe."AuditEvent" SET id = 2;

CREATE SCHEMA
CREATE TABLE
CREATE TRIGGER
INSERT 0 1
ERROR:  AuditEvent is append-only: UPDATE is not permitted
CONTEXT:  PL/pgSQL function audit_event_is_append_only() line 3 at RAISE
DROP SCHEMA
```

Probe schema dropped; `SELECT count(*) FROM information_schema.schemata WHERE schema_name='m4probe'`
returns `0`. The live function body is
`RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;`. The disposition —
leave the migration byte-unchanged — is honoured: `git diff --name-only 4487515~1..HEAD` names no
migration, and the file's last touching commit is still `baa2266`.

The "**three** files, not two" correction is also right. Excluding the Task 8 ledger documents that
discuss the finding itself, `grep -rln "AuditEvent is append-only"` finds exactly three
ledger/plan documents: `phase-1/review-diffs/review-0990cbb..17989c8.diff`, `phase-1/task-06/brief.md`,
`plans/2026-08-20-phase-1-foundation.md`.

### `VerificationToken.userId` is `onDelete: Cascade`. **TRUE.**

Confirmed in `packages/db/prisma/schema.prisma`, and it is the reason the `user === null` branch is
unreachable from the integration lane. The narrow `control.redeemableUserId` is the right shape for
it (see F0's fake audit below).

### `escape-html.spec.ts`'s "seven of the eight templates address the recipient by name". **TRUE.**

Counted by hand off the registry (`registry.ts:46-55` — eight members; `TOKEN_LINK_TEMPLATE_IDS`
three, `NOTICE_TEMPLATE_IDS` five). `recipientName` is rendered at `notice.templates.ts:74`
(`passwordChanged`), `:117` (`renderMfaChanged`, which serves both `mfaEnabled` and `mfaDisabled`),
`:201` (`registrationAttempt`), `:232` (`newDeviceSignIn`), and `token-link.templates.ts:40`
(`emailVerification`), `:63` (`passwordReset`). That is seven. `renderInvitation`
(`token-link.templates.ts:96`) addresses no one by name, and its own docblock gives the stated
reason — "its recipient may have no `User` row at all". Every count in the round checks out:
**eight templates, five notices, three token-link.**

### The redacting serialiser blanks `body`/`text` **by field name**. **FALSE — see F2.**

### The `redeemableUserId` weakening — can it make another test vacuous? **No.**

`grep -rn "redeemableUserId" apps/api/src` returns the declaration, the initialiser, the two
read sites in the fake, and exactly **one** consumer: `email-verification.service.spec.ts:116`.
Both mutated fake methods are behaviourally identical to their previous versions while the flag is
`null` (`updateMany` → `count: 0`, `findUnique` → `null`), so no existing test's meaning changed.
The control is correctly defaulted off. (One false sentence in its comment — finding F4.)

---

## Findings

### F1 — H1 IS NOT CLOSED. Attacker-chosen text still reaches `registrationAttempt`, via `recipientName`, and the fix round measured that and turned the assertion off

**Severity: High, for a live control — the same control, the same template, and the same
self-contradicting message the original H1 was raised for.** This is not a missing test over
correct code.

**The channel.** `registration.service.ts:141` writes `User.name` from the request body on the
new-account path:

```ts
await tx.user.create({ data: { id: userId, email: command.email, name: command.name } });
```

`registerRequestSchema` (`packages/contracts/src/auth.ts:85`) bounds `name` at
`z.string().trim().min(1).max(200).optional()` — 200 characters of arbitrary text, no content
restriction. And `registration.service.ts:219`, on the *existing*-account path, feeds that stored
value straight into the notice H1 was about:

```ts
recipientName: existing.name ?? ANONYMOUS_GREETING,
```

**The attack, two unauthenticated requests.**

1. `POST /api/v1/auth/register` with `email = victim@example.test` (an address with no Sentinel
   account) and `name = <phishing sentence including a URL>`. `createAccount` runs: the victim's
   `User` row is created carrying the attacker's text, and `emailVerification` is mailed **to the
   victim**, who never asked for it.
2. `POST /api/v1/auth/register` with the same address. The address now exists, so
   `recordBlockedAttempt` mails `registrationAttempt` to the victim with
   `recipientName = existing.name` — the attacker's text.

**Proof, rendered through the shipped templates in `apps/api/dist`.** Step 1's message:

```
--- TEXT PART ---
Confirm your email address

Hello Sentinel Security -- ACTION REQUIRED: confirm at https://sentinel-support.example/verify?t=abc,

Confirm this address to finish setting up your Sentinel account.
...
Confirm email address: https://app.sentinel.test/verify-email?token=FIXTURE_tok_…

--- html contains attacker url? --- true
```

Step 2's message — the security notice, with its own footer three lines below the injected link:

```
--- TEXT PART ---
Someone tried to create a Sentinel account with your email address

Hello Sentinel Support -- your account is at risk, verify now: https://sentinel-support.example/verify?t=abc,

Someone submitted this email address to the Sentinel sign-up form. …

When: 2026-08-26 09:41 UTC

--
If this was not you, no action is needed. No account was created and your existing account is unchanged.
Sentinel will never ask you for your password or a code by email or phone, and never includes a link in a security notice like this one.

--- html has https:?  true
--- text has https:?  true
```

That is H1's exact finding, word for word: a URL inside a message whose footer says the product
never puts one there, in the recipient's inbox, from Sentinel's sending domain.

**Why the suite cannot see it, and this is the part that should not have happened.** The fix
round's own new test is named `carries no link when EVERY CALLER-SUPPLIED field is a URL`
(`registry.spec.ts`), and it does not include the caller-supplied field that carries the payload.
Adding `name` to its input — one word — turns it red immediately:

```
$ # registry.spec.ts, context-free test: { ...BENIGN, name: XSS_WITH_URL, ipAddress: …, userAgent: … }
   × context-free notice registrationAttempt > carries no link when EVERY CALLER-SUPPLIED field is a URL
     → expected 'Someone tried to create a Sentinel ac…' not to match /https?:\/\//
 Test Files  1 failed (1)
```

The exclusion is deliberate and its reason is written into the file
(`registry.spec.ts`, the sibling test in the `NOTICE_TEMPLATE_IDS` block):

> "NOT the display name, and that exclusion is a measurement rather than a convenience. I first
> wrote this test with `name` injected too; it failed for all five notices … It is also not a
> defect: `recipientName` is always the RECIPIENT'S OWN stored name. **An attacker who puts a URL
> there has put it in a message delivered to themselves.**"

The first half is a true statement about the data flow — the value *is* the row's own `name`. The
inference is false, and it is the whole finding: **an attacker sets a victim's `User.name` by
registering the victim's address first.** The round saw the red test that H1 needed, and reasoned
its way to turning it off.

**Bounds, stated so this can be dispositioned with full information.**
- 200 characters, not 512. HTML-escaped, so not XSS.
- Rate limited: `registration` is 3/hour per IP, fail-closed, and I re-confirmed the class is on
  the handler (mutation R12b below).
- The target address must have **no** Sentinel account for step 1 to seed the name; a victim who
  already has an account cannot have their name set this way.
- Step 1 alone is already an unsolicited branded email carrying attacker text and a live call to
  action to a stranger. Step 2 is the one that reopens the footer contradiction, and it needs the
  attacker to have won step 1 for that address.
- Side effect worth naming separately: the victim's account now exists, unverified, with a name
  they did not choose, and they cannot register that address themselves.
- Nothing leaks into a log or an audit row — `USER_REGISTERED`'s metadata carries only
  `hasName: boolean` (`registration.service.ts:159`), which is correct.

**This is not a request for a filter.** The same structural argument the H1 fix makes applies:
either the notice does not render a name it did not verify the recipient chose, or `name` is not
free text. Deciding that is the orchestrator's, not mine.

---

### F2 — "the redacting serialiser blanks `body` and `text` by field NAME" is false. It is now a carry-forward ruling, a line in `roadmap.md`, and a code comment

**Severity: Medium, as prose about a security control — this project's dominant defect class, and
this instance was produced while correcting an earlier finding.** The fix itself (an exact key set)
is correct and does kill the mutation; the conclusion drawn around it is not.

The claim appears three times, each time as a measurement:

- `fixes.md`: "The redacting serialiser blanks the field **names** `body` and `text` outright, so
  the body never reaches the line at all and **no value-based assertion can fail under R9**."
- `progress.md`, **carry-forward ruling 67**: "The redacting serialiser blanks `body` and `text` by
  field NAME, not by value pattern."
- `auth-mailer.spec.ts`, in the docblock of the fix: "The redacting serialiser blanks those two
  field NAMES outright."
- and once more in `roadmap.md`: "the redacting serialiser blanks the `body` field by name".

**It does not.** `packages/observability/src/redaction.ts:10-24` is the entire field-name denylist —
`password, passwd, secret, token, apikey, api_key, authorization, cookie, privatekey, private_key,
sessionid, session_id, mfasecret` — and neither `body` nor `text` is on it, nor contains any of
them as a substring:

```
$ node --input-type=module -e "import {redact} from './packages/observability/dist/index.js'; …"
{"body":"[redacted]","text":"plain no link at all","other":"x"}
{"body":"Someone tried to create a Sentinel account. When: 2026. No link here.","text":"no link"}
```

The first object's `body` was blanked because its **value** matched
`SECRET_VALUE_PATTERNS`' `?token=` rule (`redaction.ts:75`), which replaces the whole structured
field. `text` in the same object, with no URL, came through verbatim. The second object — a notice
body — came through verbatim under both keys.

Through the real logger with the real template, the difference is not academic:

```
$ node --input-type=module -e "… EMAIL_TEMPLATES.registrationAttempt(…) → logger.warn({body, text, …}) …"
body redacted?  false
text redacted?  false
text field emitted verbatim: "Someone tried to create a Sentinel account with your email address\n\nHello Ada,\n\nSomeone submitted this email address to the Sentinel sign-up form. This address is already in use, so no second account was created and…"
```

**What the correct statement is.** The redactor blanked the verification body because that body
contains a `?token=` URL, which is a *value*-shape backstop and applies only to messages that carry
a credential. Five of the eight templates carry no link at all, and for those a `body` binding is
logged in full — against `CLAUDE.md`'s rule 6. So the original L3 finding was closer to right than
the "correction": the redactor is a value-shape net, not a name denylist, and it does not cover the
notices at all.

Ruling 67 is the part that matters, because a ruling binds every later task. As written it tells a
future implementer that `body` is a safe key name. It is not.

---

### F3 — `roadmap.md` says "all six migrations are applied". There are eight, and Task 8 shipped two of them

**Severity: Medium, for the file `CLAUDE.md` calls the single source of truth for status, in a
paragraph this round wrote.**

`roadmap.md:1365`, in the Task 8 block added by `d3a43de`:

> "`has_schema_privilege('sentinel_app','public','USAGE')` now returns `t` where Task 7 measured
> `f` twice, and **all six migrations are applied**."

The privilege half is true — I measured `t`. The count is not:

```
$ ls packages/db/prisma/migrations/ | grep -v migration_lock | wc -l
8
$ docker compose exec -T postgres psql -U sentinel -d sentinel -tAc \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"
8
```

Eight on disk, eight applied, including `20260828051452_platform_audit_event` and
`20260828051500_verification_token_partial_unique` — Task 8's own. `git log -S "all six migrations
are applied"` names `d3a43de` as the commit that introduced the sentence, so it is new, not
inherited. (Lines 423 and 430 also say "six" and are correct: they are dated records from
2026-08-25, when there were six.)

---

### F4 — `identity-fakes.ts`'s comment names the wrong discriminator for the redemption update

**Severity: Low, as prose in test infrastructure the round deliberately weakened.** The code is
right; the sentence explaining why is wrong.

```ts
// `consumedAt: null` in the predicate marks the REDEMPTION update;
// `issue`'s supersede pass carries `purpose` and `userId` instead. Only
// the former is allowed to report a hit, so setting the flag cannot
// accidentally make a supersede look like it consumed a row.
const isRedemption = 'tokenHash' in args.where;
```

Both `updateMany` predicates carry `consumedAt: null`, and the redemption carries `purpose` too:

- supersede — `token.service.ts:247`: `where: { userId, purpose, consumedAt: null }`
- redemption — `token.service.ts:326`: `where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: consumedAt } }`

So neither half of the stated rule is true. The discriminator the code actually uses —
`'tokenHash' in args.where` — *is* correct and *is* unique to the redemption, so the safety property
the comment is defending holds; only the explanation of it is false. It matters because this
comment is the justification for a fake that can now report a successful redemption.

---

### F5 — a green test named for a property that is false for four of the five templates it runs against

**Severity: Low, for the honesty of the test report.** `registry.spec.ts`, inside
`describe.each(NOTICE_TEMPLATE_IDS)`:

```ts
it('carries no link when the value the CALLER supplied is a URL', () => {
  const email = CASES[id]({ ...BENIGN, ipAddress: XSS_WITH_URL, userAgent: XSS_WITH_URL });
  if (CONTEXT_FREE_NOTICE_IDS.includes(id as …)) {
    expect(email.html).not.toMatch(/https?:\/\//);
    expect(email.text).not.toMatch(/https?:\/\//);
  }
});
```

For `passwordChanged`, `mfaEnabled`, `mfaDisabled` and `newDeviceSignIn` the body executes no
expectation at all, and Vitest prints four green lines claiming a property that is **false** for
those templates. Removing the `if` proves it:

```
   × notice template passwordChanged   > carries no link when the value the CALLER supplied is a URL
   × notice template mfaEnabled        > …
   × notice template mfaDisabled       > …
   × notice template newDeviceSignIn   > …
     → expected '<!doctype html>…' not to match /https?:\/\//
```

The `describe.each(CONTEXT_FREE_NOTICE_IDS)` block immediately below asserts the same property
properly, so this test buys nothing and costs four misleading green lines. The characterisation
test for the other four is the right idea and already exists — this one should be deleted or moved
inside the partition.

---

### F6 — `token-invalid.error.ts` says "four paths" and lists three

**Severity: Low, as prose.** The M7 rewrite:

> "`EmailVerificationService.verify` raises it on **four paths**: a token `consume` refused (itself
> four outcomes), a user row that has vanished, and an account whose `status` is not `ACTIVE`."

Three items, and three raise sites:

```
$ grep -n "throw new TokenInvalidError" apps/api/src/modules/auth/email-verification.service.ts
101:      if (consumed === null) throw new TokenInvalidError();
106:      if (user === null) throw new TokenInvalidError();
107:      if (user.status !== ACTIVE_USER_STATUS) throw new TokenInvalidError();
```

`grep -rn "TokenInvalidError()"` over `apps/api/src`, excluding specs and the error's own file,
finds no fourth raiser anywhere. The rest of the rewritten docblock is accurate — I verified that
no audit event is written on the failure path, and that the reason given (the refusal throws and
rolls back the transaction the event would live in) matches the code.

---

### F7 — no Nest-app-building spec can be run as a file subset, in either lane

**Severity: Low, for tooling — and NOT introduced by this round.** Recorded because it invalidates a
method two ledger documents now recommend.

Running any spec that builds a Nest testing module on its own fails, on a clean tree, in both
projects:

```
$ pnpm vitest run --project unit apps/api/src/common/guards/email-verified.guard.spec.ts
Error: Nest can't resolve dependencies of the DiscoveryService (?).
  Please make sure that the argument ModulesContainer at index [0] is available in the DiscoveryModule module.
 Test Files  1 failed (1)
      Tests  16 skipped (16)

$ pnpm vitest run --project integration --no-file-parallelism \
    apps/api/src/modules/auth/auth.verification.integration.spec.ts
… same error …
 Test Files  1 failed (1)
      Tests  14 skipped (14)
```

The sanctioned commands are unaffected — `pnpm test` (1125) and `pnpm test:integration` (230) both
pass, twice each. I checked it out at `7c31ea0`, before the fix round, and it fails identically
there, so this round did not cause it.

Two consequences worth writing down:

- `.claude/development/testing.md`'s new L8 paragraph tells the reader to run a subset with
  "`pnpm test:integration`, or pass `--no-file-parallelism` yourself". The second option does not
  work today. The advice is sound in principle and non-actionable in practice.
- `review.md`'s L8 measurement (`clean 3-file run 1 exit=0 … 39 passed`) is not reproducible on this
  machine now; the 3-file run fails before any test executes. Every integration-lane mutation in
  *this* document therefore used the full `pnpm test:integration`.

---

### F8 — L7's fix is a type narrowing only; nothing was ever selected

**Severity: Low, informational.** `fixes.md` records L7 as "`status` dropped from the lookup", and
the guard's new docblock says "The lookup selected `status` and never read it." `EmailVerifiedGuard`
passes no Prisma `select` — `this.prisma.user.findUnique({ where: { id } })` returns every column
either way. What changed is the width of the structural interface `VerifiedEmailLookup`, which is a
compile-time statement of intent and costs nothing at runtime. The reasoning added to the docblock
(status belongs at authentication, not on a verification gate) is sound and I agree with it; only
"selected" overstates what the code did. `grep` confirms nothing else references
`VerifiedEmailLookup`, and the guard's 16 specs still pass in the full lane.

---

## Pass 2 — mutation results. 12 mutants, 12 killed

All applied to the implementation except the two marked *(test-side probe)*, which exist to answer
"would this test notice if its own premise broke". All reverted; `git status --porcelain` empty
after each.

| # | Mutation | Target | Result |
|---|---|---|---|
| R12b | All three `@RateLimit()` on `auth.controller.ts` → `generalSession` | M1 | **killed** — `expected 'generalSession' to be 'registration'`, and the same for `emailVerificationConsume` and `emailVerificationResend` |
| R30 | A fourth handler (`login`) added to `AuthController` | M1 exhaustiveness | **killed** — `expected [ 'login', 'register', …(2) ] to deeply equal [ 'register', …(2) ]` |
| P1 | *(test-side probe)* `PATH_METADATA` → `'path__renamed_by_nest'` | M1 vacuity | **fails loudly** — the probe test goes red first (`expected undefined to be 'probe'`), then the three route tests. It does **not** go silently green. |
| R3 | `verify`'s status check → `=== 'LOCKED'` | M2 | **killed** in the integration lane — `refuses a DISABLED account and leaves the token unconsumed → expected 422 "Unprocessable Entity", got 200 "OK"`; `1 failed | 229 passed`. Survives the unit lane, as the round reported. |
| R9 | `body: rendered.html, text: rendered.text` added to `deliver`'s warn bindings | L3 | **killed** — `expected [ 'body', 'err', 'level', 'msg', …(5) ] to deeply equal [ 'err', 'level', 'msg', …(4) ]` |
| R25 | `if (user === null) throw` → `return` | L4 | **killed** — `promise resolved "undefined" instead of rejecting` |
| R6b | `userAgent.slice(0, USER_AGENT_MAX_LENGTH * 10_000)` | L1 | **killed** — `expected 'AAAA…' to have a length of 512 but got 5000` |
| R7 | Audit `ip` taken from `X-Forwarded-For` | L2 | **killed** — `expected '198.51.100.1' to be '203.0.113.7'` |
| R14 | `registrationAttempt` restored to `NOTICE_FOOTER` | L9 | **killed** — `expected 'Someone tried to create a Sentinel ac…' to contain 'no action is needed'` |
| H1r | `renderRegistrationAttempt` takes `SecurityNoticeContext` again and renders `...whereAndWhen(context)` | H1 | **killed, 3 red** — the exact three the round reported; `pnpm typecheck` still exits 0, so the compile-time barrier is `AuthMailer.sendRegistrationAttempt`'s signature, not the template's type alone |
| M8a | `requestBody` emission deleted from `operationFor` | M8 | **killed** — `expected undefined to deeply equal { …(3) }`, **and** `pnpm check:openapi` exits 1 naming the removed `paths./api/v1/auth/verify-email.post.requestBody` |
| M8b | Committed `openapi.json`: `additionalProperties` → `true` on register's body | M8 drift | **killed** — `pnpm check:openapi` exits 1, "At least one difference REMOVES or CHANGES something" |
| F5v | *(test-side probe)* `if` guard stripped from the notice link test | F5 | **4 previously-green parameterisations go red** — the finding |
| F1v | *(test-side probe)* `name: XSS_WITH_URL` added to the context-free notice input | F1 | **goes red** — the finding |

**Every fix in the round holds under the mutation it was written for.** The failures I found are in
what the round *concluded*, not in what it built.

### The emitted OpenAPI document

`openapi: "3.0.3"`; the three `POST` routes carry `requestBody`, the four `GET`s do not. The shape
conforms to the OAS 3.0 Request Body Object — `description?`, `required`, `content` →
`application/json` → `schema` — and `.strict()` does reach the wire as
`additionalProperties: false`, with `email` `maxLength: 254`, `password` `minLength: 12`, `name`
`maxLength: 200`. I could **not** run a formal OpenAPI validator: no such package is installed and
this review made no network calls. The structural check is by hand.

---

## Attacks I made that failed — the code was right

- **Making the `redeemableUserId` control leak into another test.** One consumer, and both mutated
  fake methods are behaviourally identical while the flag is `null`. It cannot make anything else
  pass vacuously.
- **Getting the metadata probe in `auth.controller.spec.ts` to go quietly vacuous.** It fails first
  and loudly.
- **Finding a fourth `TokenInvalidError` raiser** to justify the docblock's "four paths". There
  isn't one.
- **Finding a second false `.claude/` cross-reference.** `api/conventions.md` §2 is
  "Methods and status codes" and line 42 is literally `| 201 | Created, with \`Location\` |`, so
  L6's fix cites a section that exists and says what is claimed. `api/conventions.md` §6 is
  "Concurrency" and says nothing the M8 change makes true or false, so the brief's instruction to
  check it needed no edit — though `fixes.md` does not record that it was checked.
- **Finding the M3 spec names still wrong.**
  `grep -rn "platform-audit.integration.spec\|platform-audit.actions.spec"` over the source tree
  returns nothing, and both replacement citations resolve:
  `platform-audit.service.spec.ts:108` is the §4 taxonomy parity test, and
  `auth.verification.integration.spec.ts:91` is
  `expect(JSON.stringify(events[0]?.metadata)).not.toContain(tokenFromMail(h.sent[0]))`.
- **Finding a surviving "seven templates".** Five corrected, `app.module.ts:41` correctly left — it
  is a statement about what Task 5 shipped, and Task 5 did ship seven.
- **Making an attacker's IP or user agent reach `registrationAttempt` again.** The two-layer
  structural fix holds: there is no parameter on `AuthMailer.sendRegistrationAttempt` and no field
  on `RegistrationAttemptContext`. F1 is a *different* field, not a hole in that fix.

---

## What I could not check

- **Nothing has run in CI.** The branch is unpushed with no pull request. Every figure here was
  measured on this machine, on Windows, with one Node version.
- **I did not formally validate `openapi.json`** — no offline validator, no network.
- **I did not re-derive the resend timing figures** (25 samples × 3 cases). Same decision the first
  reviewer made and for the same reason; ruling 68 still rests on one unreplicated measurement.
- **I did not exercise F1 end to end through HTTP.** The proof is the code path plus the rendered
  templates from `apps/api/dist`; demonstrating it against the live server would need a spec file,
  which a findings-only review does not add. Nothing in the path is conditional on transport.
- **`pnpm db:reset` was not run** and cannot be (ruling 3), so the eight migrations were not
  replayed from empty by me; `migration.integration.spec.ts` does it in the integration lane.
- **`pnpm test:e2e` was not run** — no Playwright journey touches these routes.
- **F7's root cause.** I established it is deterministic, affects both lanes, predates this round,
  and does not affect the sanctioned commands. I did not diagnose why the subset run resolves two
  copies of `@nestjs/core`.
