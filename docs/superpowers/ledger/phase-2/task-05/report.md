# Phase 2 · Task 5 — implementer report

> **A dated record of commands run and their output. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Branch `feat/phase-2-task-05`, cut from `main` at `c641b9d`. Not pushed, no PR.

## 1. Verification commands and exit codes

Run in this order after the last commit, with the compose stack up. Every code below was
captured as the shell status
immediately after the command, outside any pipe, by a loop writing each line to a file before
anything was read back. `docker compose ps` was run last, from the repository root.

| Command                 | Exit | Reported output                                                        |
| ----------------------- | ---- | ---------------------------------------------------------------------- |
| `pnpm format:check`     | 0    | `All matched files use Prettier code style!`                           |
| `pnpm lint`             | 0    | 14 tasks successful                                                    |
| `pnpm typecheck`        | 0    | 14 tasks successful                                                    |
| `pnpm test`             | 0    | 60 files, **786 tests** passed                                         |
| `pnpm check:specs`      | 0    | `73 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | 0    | 13 files, **169 tests** passed                                         |
| `pnpm build`            | 0    | all tasks successful                                                   |
| `pnpm check:openapi`    | 0    | `routes: 4` — see section 2                                            |
| `pnpm check:registry`   | 0    | `14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global`     |
| `docker compose ps`     | 0    | all four services `Up 11 hours (healthy)` — mailpit on 1025 and 8025  |

`pnpm test:e2e` was not run — out of scope per the brief.

## 2. The two checks that prove what was *not* shipped

```
$ pnpm check:openapi
{"level":"info","time":"2026-08-26T02:05:56.136Z","service":"api","path":".openapi-check.json","routes":4,"msg":"OpenAPI document written"}
exit 0
```

**4 routes.** `MailModule` is registered in `AppModule` and registers no controller.

```
$ pnpm check:registry
check:registry OK — 14 models, 3 tenant-owned, 1 tenant root, 10 deliberately global. DMMF verified against packages/db/prisma/schema.prisma.
exit 0
```

```
$ git diff --stat main...HEAD -- pnpm-workspace.yaml packages/db/prisma/schema.prisma
(no output)
```

Carry-forward ruling 39 does not apply: `schema.prisma` was never opened, so `prisma generate`
was not needed. The empty diff above is the evidence, not a clean `git status`.

## 3. Ruling 43 — the dependency, and the cooldown

```
$ npm view nodemailer version time.modified
version = '9.0.5'
time.modified = '2026-08-07T09:36:04.091Z'

$ sha1sum pnpm-workspace.yaml                            # before both installs
3746661e1c6edeaa9238f821393806cbceb85fa1 *pnpm-workspace.yaml
$ pnpm --filter @sentinel/api add nodemailer             # Done in 9s
$ pnpm --filter @sentinel/api add -D @types/nodemailer   # Done in 6.7s
$ sha1sum pnpm-workspace.yaml                            # after
3746661e1c6edeaa9238f821393806cbceb85fa1 *pnpm-workspace.yaml
```

No `minimumReleaseAgeExclude` entry was written and none was needed. Installed
`nodemailer@^9.0.5` as a dependency and `@types/nodemailer@^8.0.1` as a devDependency.

## 4. Test-first evidence

| Step | Red run | Green run |
| --- | --- | --- |
| `apiEnvSchema` vars | `6 failed, 40 passed (46)` at `bb0dd09` | `46 passed` at `ab8c2e9` |
| Six templates | `4 failed (4)`, `no tests` — modules absent, at `1cd9b0a` | `113 passed (4 files)` |
| Mailer + adapter | `3 failed (3)`, `no tests` — the three implementation files moved out of the tree, then restored | `19 passed (3 files)` |
| Mailpit integration | `MAIL_PORT=1 …` gives `5 failed, 1 passed (6)`, `connect ECONNREFUSED 127.0.0.1:1` | `6 passed`, 285ms |

The integration spec's red run is a **non-vacuity** check rather than a pre-implementation one:
the adapter already existed by then, so the useful question was whether the spec can fail at all.
It can — five of six cases fail when nothing is listening on the SMTP port. The sixth is the case
asserting that an unreachable relay raises, and it passes either way by design.

## 5. Ruling 50 — Mailpit was not emptied

`DELETE /api/v1/messages` is never **invoked** in this change. [Fix-round correction,
2026-08-26: this sentence originally read "appears in no file in this change", which is false as
written — the string appears as prose in three files (this report, the brief, and the integration
spec's docblock). The intended claim, that nothing ever calls it, is true and the reviewer verified
it independently. Review finding L4.]

```
$ curl -s http://127.0.0.1:8025/api/v1/info    # before any spec ran
Messages 0  SMTPAccepted 0  MessagesDeleted 0
$ curl -s http://127.0.0.1:8025/api/v1/info    # after the mail spec alone
Messages 5  SMTPAccepted 5  MessagesDeleted 0
$ curl -s http://127.0.0.1:8025/api/v1/info    # after the final full pnpm test:integration
Messages 15 SMTPAccepted 15 MessagesDeleted 0
```

`MessagesDeleted 0` across the whole task. Each case sends to its own
`task05-<uuid>@sentinel.test` address and finds its message by searching for that address.

## 6. One delivered message, read back out of Mailpit

```
$ curl -s "http://127.0.0.1:8025/api/v1/message/<id>"
Reset your Sentinel password
---TEXT---
Reset your Sentinel password

Hello Ada Lovelace,

Someone asked to reset the password on your Sentinel account. Use the link below to choose a new one.

This link can be used once and expires in 1 hour. Resetting your password signs you out everywhere else.

Choose a new password: http://localhost:3000/reset-password?token=<token redacted — see ruling 57>

--
If you did not ask for this, no action is needed and your password stays as it is.
Sentinel will never ask you for your password or a code by email or phone.
```

[Fix-round correction, 2026-08-26. The raw 256-bit token was pasted here verbatim and has been
replaced. It was minted for a Mailpit send, no `VerificationToken` row was ever written and no
account exists, so nothing was exposed in substance — but `CLAUDE.md` rule 6 says never log a
token, a ledger file is a file, and the habit is the control. Review finding L3, ruling 57.]

## 7. Commits

Oldest first. Every message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

| SHA | Subject |
| --- | --- |
| `bb0dd09` | `test(config): pin SMTP auth and TLS onto apiEnvSchema, before it has them` |
| `ab8c2e9` | `feat(config): SMTP authentication and implicit TLS on apiEnvSchema` |
| `1cd9b0a` | `test(auth): the email templates, specified before any of them exist` |
| `942f6a3` | `feat(auth): six email templates behind a registry, with one layout` |
| `1d0f6e2` | `test(api): the Mailer port and its SMTP adapter, specified first` |
| `9dcf75f` | `feat(api): the Mailer port, one SMTP adapter, and MailModule` |
| `e2bc88c` | `test(api): send through real SMTP to Mailpit and read the message back` |
| `5052a20` | `docs(architecture): mail is infrastructure, not a Phase 9 integration` |
| `5af8627` | `refactor(auth): one table for the benign and hostile template renders` |

`083f9f0` (ADR-0016) and `71c186d` (this brief) were already on the branch before dispatch.

## 8. Files created

| Path | Lines |
| --- | --- |
| `apps/api/src/infrastructure/mail/mailer.port.ts` | 72 |
| `apps/api/src/infrastructure/mail/smtp-mailer.ts` | 160 |
| `apps/api/src/infrastructure/mail/mail.module.ts` | 53 |
| `apps/api/src/infrastructure/mail/smtp-mailer.spec.ts` | 190 |
| `apps/api/src/infrastructure/mail/mail.redaction.spec.ts` | 149 |
| `apps/api/src/infrastructure/mail/mail.module.spec.ts` | 77 |
| `apps/api/src/infrastructure/mail/smtp-mailer.integration.spec.ts` | 268 |
| `apps/api/src/modules/auth/emails/escape-html.ts` | 53 |
| `apps/api/src/modules/auth/emails/escape-html.spec.ts` | 70 |
| `apps/api/src/modules/auth/emails/links.ts` | 64 |
| `apps/api/src/modules/auth/emails/links.spec.ts` | 120 |
| `apps/api/src/modules/auth/emails/layout.ts` | 216 |
| `apps/api/src/modules/auth/emails/layout.spec.ts` | 162 |
| `apps/api/src/modules/auth/emails/token-link.templates.ts` | 113 |
| `apps/api/src/modules/auth/emails/notice.templates.ts` | 142 |
| `apps/api/src/modules/auth/emails/registry.ts` | 68 |
| `apps/api/src/modules/auth/emails/registry.spec.ts` | 283 |

Every file is under the ~300-line limit. `registry.spec.ts` was 319 and was refactored at
`5af8627`, which is also where the duplication that made it long was removed.

## 9. Files changed

| Path | Change |
| --- | --- |
| `packages/config/src/env.ts` | `MAIL_SECURE` / `MAIL_USERNAME` / `MAIL_PASSWORD` inside the base object; `superRefine` split into `checkArgon2Cost` and `checkMailCredentialPair` |
| `packages/config/src/env.spec.ts` | 9 cases for the three variables and the pairing rule |
| `apps/api/src/infrastructure/tokens.ts` | `MAILER` token |
| `apps/api/src/app.module.ts` | `MailModule` registered |
| `apps/api/package.json` | `nodemailer`, `@types/nodemailer` |
| `pnpm-lock.yaml` | those two resolutions |
| `.env.example` | the three variables, documented and commented out |
| `.claude/architecture/integrations.md` | new section 7, per the brief's *Doc ownership* |

`.claude/product/roadmap.md` was **not** edited. `.claude/security/authentication.md` was not
edited — section 6 describes the token discipline, which this task does not alter.

## 10. Deviations from a ruling, with reasons

Five. None ignores a ruling; four take one further, one restructures code a ruling touched.

**D1 — `OutgoingMail` carries a required `templateId`, which ADR-0016's stated signature
`send({ to, subject, html, text })` does not have.** Ruling 47 requires the adapter to log the
template id and forbids it logging any part of the body, so the id is the only thing an operator
has to go on when asking whether a given notice was sent — and ADR-0016 itself names silent
non-delivery of a notice as this phase's real gap. An optional field is one the first caller
forgets, leaving a log line that says nothing. A refinement of the ADR's signature, not a
departure from its decision: the port is still one method.

**D2 — the username/password pairing rule is enforced twice**, in `apiEnvSchema` (ruling 48's
"crashing at boot") and again in `toTransportOptions`. Ruling 48 named only the schema. The
adapter is constructible from something other than the environment — a future factory, a worker,
a spec — and a control that lives only in the schema is one the next caller bypasses. Cost: one
branch and two test cases.

**D3 — the existing `superRefine` was restructured, which no ruling asked for.** It opened with
an early return, correct while it was the only rule. A second rule behind that return would have
been silently skipped whenever the Argon2 relationship failed, so an operator would fix one
variable and rediscover the next on the following boot. Two named checks are now called side by
side, and two spec cases pin that neither can disable the other.

**D4 — the three notice templates contain no link at all, not merely no token.** The brief
required only "no token". "Your password was changed — click here if this wasn't you" is the
entire phishing pretext for this message class, and a product whose real notices never link has
taught its users that one which does is fake. It also makes it structurally impossible for a
future edit to drop a credential into one of these bodies. Accepted cost: the recipient navigates
to the product themselves, and there is no deep link to `/settings/security` — that screen does
not exist until Task 17, so the alternative would have shipped a 404.

**D5 — two registry ids (`mfaEnabled`, `mfaDisabled`) over one renderer.** The brief left this
open. Two ids gives ruling 45's table both states rather than one, and — because ruling 47 has
the adapter log the id and nothing from the body — an operator reading logs can tell which of the
two was sent without opening the message. "MFA was disabled" is the security-relevant half.

## 11. Additions beyond the brief

Both are defences no ruling asked for, added after following the input path.

**A1 — the subject is stripped of control characters (`layout.ts`).** The subject is the one
rendered value that leaves as an SMTP header; an organisation name reaches the invitation
subject; CRLF in a header value is `Bcc:` injection. `escapeHtml` does not help, because a
subject is never markup. nodemailer's MIME encoder also refuses newlines in a header, so this is
a second line rather than the only one — the same reasoning ruling 47 gives for not relying on
the redaction pattern alone.

**A2 — `SmtpMailer.send` refuses a recipient address containing CR, LF or NUL.** Same class at
the envelope: `to` reaches an SMTP `RCPT TO` command and a `To:` header. Task 8 will pass an
address from a registration form; Zod validates it at that boundary and this is the second line.

## 12. Judgement calls a reviewer may want to overturn

**J1 — `escapeHtml` does not encode the forward slash.** OWASP's aggressive set does, on a
"premature closing tag" argument that cannot apply once `<` and `>` are both escaped. Encoding it
would render the one URL in an `html` part with `&#x2F;` in place of every slash: unreadable in
source and unparseable by the specs that assert against a real URL. Pinned by a named test so it
is a decision, not an omission.

**J2 — `formatDuration(86_400)` returns "24 hours", not "1 day".** Only the day unit carries a
minimum count of 2. Section 6 of `authentication.md` states the verification lifetime as 24h, and
"expires in 1 day" reads as a rounded approximation of what is an exact deadline. Two days and up
render as days.

**J3 — `MailModule` is registered in `AppModule` although nothing injects `MAILER` yet.** The
factory therefore runs at every boot and in every integration spec, so a mailer that could not be
constructed — or that reached the network on the way up, which ruling 49 forbids — fails now
rather than at the first send six tasks later. `check:openapi` still reports 4 routes with it
registered.

**J4 — the Mailpit HTTP base URL is derived as `http://<MAIL_HOST>:8025`.** The port is a
constant in the spec, because no environment variable carries it and inventing one for a test
server would put a test concern on the schema every deploy must satisfy. The host is read from
configuration so a stack moved elsewhere does not leave the spec talking to nothing.

## 13. Not verified, stated plainly

- **Nothing here has been run in CI.** The branch is not pushed. Every number in section 1 is
  from this Windows machine against the local compose stack. `.github/workflows/ci.yml` starts a
  `mailpit` service, but that these specs pass on `ubuntu-latest` is **unverified**.
- **No production or staging SMTP relay was contacted.** `MAIL_SECURE`, `MAIL_USERNAME` and
  `MAIL_PASSWORD` are tested at the schema and at `toTransportOptions`; that nodemailer
  negotiates STARTTLS on 587 against a real relay, and that a real relay accepts credentials
  carried this way, is **unverified** and cannot be verified until a deploy exists. That is
  ADR-0016's own deferral, not a gap introduced here.
- **`MAIL_SECURE=true` was never exercised end to end.** Mailpit on 1025 is plaintext, so the
  implicit-TLS path is covered only by the mapping assertion in `smtp-mailer.spec.ts`.
- **No template has been read by a human in a real mail client.** They were read out of Mailpit's
  store through its HTTP API (section 6). Rendering in Outlook, Gmail or Apple Mail is
  **unverified**. ADR-0016 says opening `http://localhost:8025` is how template defects are
  actually caught, and that has been done here only through the API, not the UI.
- **Ruling 51 is a written contract and nothing more.** No endpoint sends mail yet, so "sending
  happens after commit, outside the transaction" is stated in `mailer.port.ts`'s docblock and
  **is demonstrated by no test**. The brief forbids simulating a caller to make it look tested,
  and none was written. It binds Tasks 8, 10, 11 and 15.
- **Delivery is not retried, not queued, and its failure is surfaced nowhere an operator would
  look.** A failed send raises at the call site and writes one error line. For a security notice
  that means the signal the notice exists to deliver never arrives and nothing detects it. Named
  in ADR-0016 and now in `integrations.md` section 7; unaddressed until Phase 4's BullMQ.
- **`pnpm test:e2e` was not run** (out of scope), and **no security scanner was run** over the new
  files.
- **The 786 and 169 totals are this branch's**, not a delta against `main` — the pre-change totals
  were not captured before work began.

## 14. Rulings this task passes forward

Proposed for `progress.md`'s carry-forward section; the orchestrator owns whether they land.

- **The link format is now fixed in `links.ts`:** `/verify-email`, `/reset-password`,
  `/accept-invitation`, each with `?token=`. **Task 16 must build screens on these three paths.**
  Changing one after a message is in an inbox breaks a link that has already been sent.
- **`buildTokenLink` takes three primitives, and `links.ts` has no imports** — asserted against
  the source text, not only the signature. Any later task tempted to pass a request, a header or
  a host into link construction is looking at the account-takeover primitive ruling 42 exists to
  prevent.
- **`registry.spec.ts`'s `CASES` table is a `Record<EmailTemplateId, …>`.** A seventh template —
  Task 15's — will **fail `pnpm typecheck` until it is added there**, and fail a test until it is
  classified as link-carrying or notice. Intended, and it lands on typecheck rather than test
  (carry-forward ruling 40).
- **Notice templates contain no link, and a spec enforces it.** A later task wanting a "manage
  your account" link in a security notice is overturning D4, not adding a feature.
- **`Mailer.send` requires a `templateId`.** Tasks 8, 10, 11 and 15 pass the registry key.
- **Ruling 51 binds Tasks 8, 10, 11 and 15:** write the row and its audit event in the
  transaction, commit, then send. A transaction can roll back and an email cannot be recalled.
