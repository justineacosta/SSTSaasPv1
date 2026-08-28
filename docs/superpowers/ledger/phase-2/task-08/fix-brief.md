# Phase 2 · Task 8 — fix round, dispositions

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-28. Written by the orchestrator after reading
[`review.md`](review.md) in full. Eighteen findings: **1 High, 8 Medium, 9 Low.**

**Seventeen are upheld and fixed. One is upheld and deliberately not fixed** — M4's migration
comment, for a reason the reviewer could not have priced. One, M5, is the orchestrator's own file
and is fixed by the orchestrator, not by you.

The review is a good one. It reproduced both orchestrator claims rather than accepting them, found
a live behavioural defect that all 1085 unit and 229 integration tests were blind to, and its
citation pass caught two invented spec filenames — the exact defect class that produced ruling 55
one task ago. Read `review.md` before this document; this one only records what happens about it.

---

## H1 — UPHELD. Fix structurally, not with a filter.

An unauthenticated caller injects up to 512 characters of chosen text, including a URL, into the
`registrationAttempt` security notice delivered to any address they can guess is registered. The
message wears Sentinel's branding and its own footer promises it contains no link.

**Do not fix this by filtering URLs out of the user-agent string.** A denylist over
attacker-controlled text is a defect waiting for a new encoding. Fix it by removing the input:
**the `registrationAttempt` notice carries no device or user-agent line at all.**

The reasoning, which belongs in a comment on the template: for every other notice
(`passwordChanged`, `mfaEnabled`, `mfaDisabled`, `newDeviceSignIn`) the device string describes an
action the *recipient's own authenticated session* took, which is why naming it is useful — it is
how they recognise a session that is not theirs. For `registrationAttempt` the device belongs to
**the attacker**, and the recipient has no account action to compare it against. It is not
context; it is a message from a stranger printed inside our envelope. Removing it costs the
recipient nothing they could have acted on.

Keep the IP and user-agent in the `PlatformAuditEvent` row. That is where an attacker-supplied
string is supposed to end up: read by an operator, in a table built for exactly this, never
rendered into a message sent to somebody else.

**Then fix the vacuous spec, which is the half that matters more.** `registry.spec.ts:277`'s
"carries no link of any kind" runs over `BENIGN`. Carry-forward ruling 58, third instance in three
tasks: **every fixture for the property sat on the harmless side of the branch.** The `HOSTILE`
fixture two declarations away contains no `http`, so swapping it in would still not have failed.

The no-link property must be asserted for **every** notice template against a fixture whose every
free-text field carries a URL — and the fixture's payload must contain `https://` explicitly, not
just angle brackets. Prove the new spec by re-introducing the device line and watching it go red;
paste that output.

---

## M1 — UPHELD. Assert the metadata on the shipped handlers, not on the table.

Three mutations survive the whole eleven-command gate: downgrading all three routes to fail-open
`generalSession`, deleting the decorators outright, and deleting just the one on `verify-email`.
`rate-limit.config.spec.ts` asserts the config table and `rate-limit.integration.spec.ts` exercises
a fixture controller — neither reads `AuthController`.

Add a spec that reads `RATE_LIMIT_METADATA_KEY` off `AuthController`'s three real handlers and
asserts the exact class on each. Prove it by re-applying mutation R12b.

Note what this is and is not: the reviewer **measured the control live** (`200,200,200,429,429` on
register). This is a hole in assurance, not an unprotected endpoint.

---

## M2 — UPHELD. The `verify` path needs its `DISABLED` case.

Narrowing `verify`'s status check to `=== 'LOCKED'` leaves 1085 unit and 39 integration tests
green, so a `DISABLED` account's verification link redeems. Carry-forward ruling 37 named this path
specifically.

Add the `DISABLED` case on **`verify`** — the existing one covers `resend`. Correct the report
sentence that claims both are covered by name.

---

## M3 — UPHELD. Two comments cite spec files that do not exist.

`platform-audit.actions.ts:7` and `platform-audit.service.ts:43` name
`platform-audit.actions.spec.ts` and `platform-audit.integration.spec.ts`. Neither exists. Both
assertions are real and live elsewhere (`platform-audit.service.spec.ts:655` and
`auth.verification.integration.spec.ts:91`). Point the comments at the files that exist.

This is ruling 55's defect class exactly, one task later, and it is worth naming as such rather
than quietly correcting.

---

## M4 — UPHELD as false, and DELIBERATELY NOT FIXED in the migration. New ruling.

The report and the migration comment both say `AuditEvent`'s trigger message changes. The reviewer
measured that it does not: `TG_TABLE_NAME` on `AuditEvent` *is* `AuditEvent`, so the rendered text
is byte-identical (`ERROR: AuditEvent is append-only: UPDATE is not permitted`).

**Correct the report. Do not touch `20260828051452_platform_audit_event/migration.sql`.**

The reviewer proposed the obvious fix and could not have known its price. Carry-forward ruling 2:
editing an applied migration changes its checksum and breaks `prisma migrate dev` — locally, on
every subsequent `pnpm db:migrate`, until a reset. Carry-forward ruling 3: `pnpm db:reset` **cannot
be run by an agent**; Prisma refuses and requires consent text only the operator can give. So
correcting one imprecise clause in a comment would cost the operator a manual database reset, and
would buy a sentence that is misleading rather than dangerous — it overstates a change that did not
happen, in a direction that makes an operator look *more* carefully at a statement that turned out
to be safe.

The correction is recorded here, in the report, and as a carry-forward ruling instead:

> **Ruling 65. A false sentence inside an applied migration cannot be cheaply corrected.** Editing
> it breaks `prisma migrate dev` for every developer until a reset that an agent cannot perform
> (rulings 2 and 3). **Every claim in a migration comment must therefore be measured before the
> migration is applied, not after** — the file is effectively immutable the moment it runs. Task 8
> shipped one unmeasured sentence there and it is staying.

Also correct in the report: the old literal appears in **three** files, not two — the reviewer
`grep`ped them.

The reviewer's harder question is answered and the answer is worth keeping: at *every prefix* of
that migration, `AuditEvent`'s triggers still refuse every `UPDATE` and `DELETE`, because the
replacement body raises unconditionally exactly as the original did. There is no partial-application
state in which its tamper resistance is weaker, so the `CREATE OR REPLACE` was the right call.

---

## M5 — UPHELD. The orchestrator's, not yours.

`roadmap.md:17` still says the API publishes 4 routes and that the mailer has seven templates. Both
are now false. **Do not edit `roadmap.md`** — the rule that implementers do not write status prose
stands, and the orchestrator updates it in the same change that moves the status, with an evidence
table behind every figure.

---

## M6 — UPHELD. Five present-tense "seven templates" statements.

`.claude/architecture/integrations.md:112` is the one `CLAUDE.md`'s documentation rule required this
change to update. `smtp-mailer.ts:16`, `mail.redaction.spec.ts:15`, `escape-html.spec.ts:13` and
`registry.spec.ts:141` are the others; the last is in a file you edited in this task.
`app.module.ts:41` is a statement about what Task 5 shipped and stays as it is — the reviewer got
that distinction right.

There are eight templates and `NOTICE_TEMPLATE_IDS` has five members.

---

## M7 — UPHELD. `token-invalid.error.ts:19,:26`.

"Nothing raises this yet" is false — `EmailVerificationService.verify` raises it on four paths. And
the promise that the forensic record "belongs in the `AuditEvent` the endpoint writes" is false
twice over: the table would be `PlatformAuditEvent`, and your own F6 decided to write no event on a
verification failure.

Update the docblock to say what is now true, **including that no event is written on failure and
why**. If F6's decision looks wrong to you when you write that sentence out, say so in the fix
report rather than quietly reversing it — that is a decision, not a cleanup.

---

## M8 — UPHELD. Close the request-body gap in the generator.

The first three routes this product has published describe what they answer and nothing about what
to send. `ApiDocDeclaration` has no `requestBody` field and
`grep -rn requestBody apps/api/src/openapi/` returns nothing — a Phase 1 limitation that was
invisible while no route had a body.

Task 8 is the right place to close it, because Task 8 is the first task with request bodies and
every later task inherits whatever shape ships here. Add an optional `requestBody` to
`ApiDocDeclaration`, emit it in `operationFor`, declare it on all three routes from the existing
contract schemas, and regenerate `apps/api/openapi.json`.

Keep it minimal and do not invent a second way to describe a schema: the existing `DocumentedSchema`
is the mechanism, and the point of it is that the schema a client reads and the schema the server
validates against are the same object. Check whether `api/conventions.md` §6 says anything the
change makes true or false, and update it if so.

---

## Lows — all upheld, all cheap

- **L1** — assert the 512-character user-agent bound. The mutant survived both lanes.
- **L2** — the audit row's IP can be switched to the client-controlled `X-Forwarded-For` with the
  suite green. Add the assertion. **Do not** start trusting the header.
- **L3** — logging the rendered email body survives; only the redactor stops the token reaching a
  log. Assert it, and note in the comment that the redactor is the second line, not the first.
- **L4** — `verify`'s `user === null` fail-closed branch is untested and the mutant answers 200.
- **L5** — the report misattributes a quotation: it is in `id.ts`, not the parity spec.
- **L6** — `api/authentication.md:163` cross-references the wrong §2.
- **L7** — `EmailVerifiedGuard` selects `status` and never reads it. Either read it or stop
  selecting it, and say which in the report.
- **L8** — the two new auth integration specs flake when run in parallel (1 of 3 on a clean tree).
  Carry-forward ruling 33's hazard now spans four suites and is undocumented. **Document it where
  ruling 33 lives**; do not restore parallelism.
- **L9** — the registration-attempt footer can be swapped for the wrong-advice one with the suite
  green. This one is adjacent to H1 — fix it in the same pass and assert the footer text.

---

## How you work this round

Fix in that order: H1 first, then the Mediums, then the Lows. **Commit the H1 fix on its own**, so
the one behavioural change on this branch is legible in the history.

For each fix, capture the failing output *before* the fix and the passing output after. A fix
without a demonstration that the test could fail is exactly the thing H1 is a finding about.

Re-run all eleven verification commands at the end, exit codes captured outside a pipe. Report to
`docs/superpowers/ledger/phase-2/task-08/fixes.md`, one entry per finding, with the disposition and
the proof. Still no status prose, still no `roadmap.md`.

If you disagree with a disposition, say so with a measurement. M4 in particular is a judgement call
about somebody else's database, and if you can show the checksum cost is not real, that changes the
answer.
