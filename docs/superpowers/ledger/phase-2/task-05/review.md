# Phase 2 · Task 5 — adversarial review

> **A dated record of what was measured on 2026-08-26. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Reviewer had no part in writing this code. Branch `feat/phase-2-task-05`, range `main..HEAD`
(13 commits, `083f9f0`..`147e61c`). Compose stack up; Postgres, Redis, MinIO and Mailpit all
`Up 11 hours (healthy)`.

**One High, four Medium, five Low.** The High is a bypass in a control the implementer added
on its own initiative (A2) and is the same shape as the control it bypasses. Every ruling
41–52 was tested by experiment rather than by reading; **rulings 42, 45, 48, 49, 50 and 52 are
delivered in substance**, and ruling 45 in particular survived a deliberately broken template.

---

## High

### H1 — the recipient guard stops CR/LF/NUL but not a comma, and nodemailer treats `to` as an address *list*

**What is wrong.** `SmtpMailer.send` refuses a recipient containing CR, LF or NUL
(`FORBIDDEN_IN_ADDRESS = /[\r\n\u0000]/`, `apps/api/src/infrastructure/mail/smtp-mailer.ts:112`).
It does not refuse a comma. nodemailer parses `to` as a comma-separated address list and issues
one `RCPT TO` per address, so a single `OutgoingMail` can be delivered to an address the caller
never intended.

**Evidence.** Probe against a local SMTP capture server, then against the real compose Mailpit.

Against a capture server, one `send` with `to: 'a@b.test, attacker@evil.test'`:

```
### H comma recipient
THREW=
RCPT_LINES=[RCPT]RCPT TO:<a@b.test> | [RCPT]RCPT TO:<attacker@evil.test>
```

Against real Mailpit on 1025, sending a `passwordReset`-labelled message to
`"<victim-uuid>@sentinel.test, <attacker-uuid>@sentinel.test"`, then querying Mailpit for the
attacker address alone:

```
### H2 comma recipient via real Mailpit
ATTACKER_RECEIVED=true
TO=[{"Name":"","Address":"zzv-82a89b03-…@sentinel.test"},
    {"Name":"","Address":"zza-be2daf11-…@sentinel.test"}]
```

The same probe also establishes that the guard is the **only** line of defence, because
nodemailer does not refuse a CRLF recipient on its own — given one directly, it silently
delivered to the *injected* address and not to the intended one:

```
### J raw nodemailer CRLF recipient
THREW=
ACCEPTED=["zzjx@sentinel.test"]
```

**Consequence.** Three of the six templates carry a live single-use credential. Any caller that
passes an address this guard accepts but that is not a single address delivers that credential to
an extra recipient — a password reset for whoever is on the right-hand side of the comma. Not
reachable today: nothing calls `Mailer.send` yet, and Task 8's Zod `.email()` at the HTTP boundary
would reject a comma. This is a second-line control that does not hold the line it claims, and the
port is the artefact Tasks 8, 10, 11 and 15 will build on.

**Ruling/rule.** No ruling names it. It defeats the implementer's own stated rationale for A2 —
"`to` reaches an SMTP `RCPT TO` command and a `To:` header… Refusing is right rather than
stripping: unlike a subject, a mangled address has no useful meaning, and there is no legitimate
sender to serve." A comma-bearing address is exactly that case and is accepted.

---

## Medium

### M1 — a token can still reach a log line through the transport's error text

**What is wrong.** Ruling 47's spec (`mail.redaction.spec.ts`) exercises the failure path with a
*synthetic* `new Error('ECONNREFUSED 127.0.0.1:1025')`, so it only ever proves that the adapter
does not add body content of its own. It never exercises text the transport itself supplies. A
relay that quotes offending content in its rejection puts that text into `err.message`,
`err.response` and `err.stack`, all of which the adapter logs via `{ ...context, err: error }`.

**Evidence.** Four real failure paths driven through the real `SmtpMailer` and the real
`createLogger`, with a sentinel token. Cases A (connection refused) and B (implicit TLS against a
plaintext server) are clean. Case C — a relay rejecting with the token inside a `?token=` URL,
the realistic content-scanner shape — **is redacted**, in both the whole-field and span forms:

```
### C rejected after DATA quoting URL
LEAKS_SENTINEL=false
"response":"[redacted]", "message":"Message failed: 550 5.7.1 Message contains a
 suspicious URL: https://app.sentinel.test/verify-email?token=[redacted]"
```

Case D — the same token quoted **without** the `?token=` prefix — leaks verbatim:

```
### D rejected quoting bare token
LEAKS_SENTINEL=true
"response":"550 5.7.1 rejected content ZZSENTINELTOKENAAAA… not allowed",
"message":"Message failed: 550 5.7.1 rejected content ZZSENTINELTOKENAAAA… not allowed",
"stack":"Error: Message failed: 550 5.7.1 rejected content ZZSENTINELTOKENAAAA… not allowed…"
```

This is precisely the residual carry-forward ruling 36 names and that `redaction.ts` documents in
its own comment — "a bare `token=` outside a URL is not covered either… both are residual".

**Consequence.** Ruling 47's outcome — no token in a log line — is guaranteed for everything the
adapter writes, and not guaranteed for what the relay says back. Bounded: it needs a relay that
echoes token material stripped of its URL. Ruling 41's redaction is the second line here and the
first line (the adapter logging no body) is intact, so this is a hole in the backstop, not a hole
in the primary control.

**Ruling/rule.** Ruling 47, and carry-forward ruling 36. Not listed in report §13.

### M2 — the subject sanitiser is bypassable at the port; only nodemailer stops header injection there

**What is wrong.** `sanitizeSubject` runs inside `renderEmail` (`layout.ts:153`). `SmtpMailer.send`
does nothing to `mail.subject`. A caller that constructs an `OutgoingMail` without going through
`renderEmail` — which the port's type permits, and which the port's own docblock invites by
listing `subject` as a plain field — gets no sanitisation.

**Evidence.** A subject of `"Hello\r\nBcc: attacker@evil.test"` passed straight to
`SmtpMailer.send` against real Mailpit:

```
### F2 CRLF subject via real Mailpit
THREW=
SUBJECT="Hello Bcc: attacker@evil.test"
```

No injection occurred — but only because nodemailer's MIME encoder folded the CRLF. No `Bcc`
header appeared in the captured DATA either (`BCC_IN_HEADERS=false`).

**Consequence.** No exploit today. The defect is that the implementer's stated principle is applied
inconsistently: deviation D2 duplicated the credential-pair check into `toTransportOptions`
because "a control that lives only in the schema is a control the next caller bypasses", and A1
justifies the subject sanitiser as a second line because "a control that exists only inside a
dependency is a control that changes when the dependency does". Both arguments apply verbatim to
the subject at the adapter, and the control is not there.

**Ruling/rule.** No ruling. Addition A1, inconsistently with deviation D2.

### M3 — the transport-reuse comment is measurably false: there is one TCP connection per email

**What is wrong.** `smtp-mailer.ts:122-125` says the transport is built once because "A transport
per message would open a TCP connection per email and discard whatever pooling the relay offers."
`toTransportOptions` never sets `pool`, and nodemailer selects its pooling transport only under
`if (options.pool)` (`nodemailer/lib/nodemailer.js:39`). The stated benefit does not exist.

**Evidence.** Three sends on one `SmtpMailer` against a counting TCP server:

```
CONNECTIONS_AFTER_CONSTRUCT=0
### connection lifecycle
SENDS=3
TCP_CONNECTIONS=3
STILL_OPEN=0
```

**Consequence.** No runtime defect — nothing leaks, and `STILL_OPEN=0` confirms connections close.
`CONNECTIONS_AFTER_CONSTRUCT=0` independently corroborates ruling 49. The defect is that a
statement of fact in shipped code is untrue, and a reader will believe pooling is in effect when
deciding whether mail volume needs work. The same claim is repeated in `smtp-mailer.spec.ts:176`
("would open a new TCP connection per email and defeat whatever pooling a relay offers"), where
the test itself only asserts the *factory* is called once — which is true and is not the claim.

**Ruling/rule.** The honesty rule. This is the phase's recurring defect class, in code rather than
in a ledger file, and it is not in report §13's list of what was not verified.

### M4 — the "seventh template" narrative is wrong, and it is being carried forward

**What is wrong.** `EMAIL_TEMPLATES` has **seven** members already, and the invitation template —
the one attributed to Task 15 — is member three, built in this task. The next template added is
the eighth, and it is not Task 15's.

**Evidence.**

```
EMAIL_TEMPLATES members = 7 [ emailVerification, passwordReset, invitation,
  passwordChanged, mfaEnabled, mfaDisabled, newDeviceSignIn ]
```

The claim appears in six places: `registry.ts` ("a seventh template added in Task 15 inherits all
of it by existing"), `registry.spec.ts` (twice), `token-link.templates.ts`, and report §14 ("A
seventh template — Task 15's — will fail `pnpm typecheck` until it is added there"). Relatedly,
the test titled `'registers the six templates authentication.md §2, §5, §6 and §7 require'`
asserts a list of seven ids (`registry.spec.ts:129-139`).

**Consequence.** The mechanism is real and I verified it (see Sound, ruling 45) — only the count
and the attribution are wrong. But report §14 proposes this sentence for `progress.md`'s
carry-forward section, which is how a Task 15 brief would inherit it and send a session looking
for a template that already exists. That propagation path is the one that produced five of Phase
1's twelve instances.

**Ruling/rule.** The honesty rule; documentation accuracy.

---

## Low

### L1 — `WEB_BASE_URL` accepts a `javascript:` scheme and it reaches an email `href`

`z.string().url()` (`packages/config/src/env.ts:21`) delegates to `new URL()`, which accepts any
scheme. Measured:

```
### F url-scheme
javascript_ACCEPTED=true
data_ACCEPTED=true
WEB_BASE_URL_javascript=javascript:alert(1)      # loadEnv returned it, no throw
```

`buildTokenLink('javascript:alert(1)', 'passwordReset', 'T')` returns `javascript:alert(1)?token=T`,
and `escapeHtml` leaves it byte-identical, so it lands intact in `href="…"`. Operator-controlled,
not attacker-controlled, and the schema line predates this task — but this change is what first
turns `WEB_BASE_URL` into an email `href`.

### L2 — `EmailAction.url` is an unvalidated string in an href sink

`actionHtml` (`layout.ts:77`) HTML-escapes `action.url` and performs no scheme check. Every action
URL today comes from `buildTokenLink`, so nothing is reachable; a future template that sources a
URL from anywhere else inherits no protection. `escapeHtml('javascript:alert(document.domain)')`
is a no-op, measured.

### L3 — a live-format 256-bit token is committed verbatim in `report.md` §6

A raw 256-bit token was pasted into the committed report. I
found the message still in Mailpit and confirmed the report quotes it byte-for-byte. Harmless in
substance — it was minted for a Mailpit send, no `VerificationToken` row was written, and no
account exists — but rule 6 ("never log … tokens") exists to make pasting a raw token anywhere a
reflex to avoid, and a ledger file is a file.

### L4 — report §5's literal sentence is false, though its intended claim is true

"`DELETE /api/v1/messages` appears in no file in this change." The string appears in three files
in this change as prose: the integration spec's docblock, the brief, and the report itself. It is
never *invoked* — I verified that, and the Mailpit counters corroborate it (see Sound, ruling 50).
Recorded because this review's Pass 1 is about sentences, not intentions.

### L5 — `escapeHtml` is adequate for quoted attributes only, and nothing enforces that layout.ts stays quoted

Measured: the function leaves `/`, `=`, space, tab, newline, `(`, `{`, `;` and `:` untouched, so
`escapeHtml('x onload=alert(1)')` is unchanged and would break out of an *unquoted* attribute.
Every attribute in `layout.ts` is double-quoted with a constant `style` value, so nothing is
reachable, and the function's docblock scopes itself honestly ("either an element body or a
double- or single-quoted attribute value"). Recorded as a constraint on future edits to that file,
not as a present defect. J1 (omitting `/`) is sound: measured, both quote characters are escaped,
which is what closes the attribute-breakout path.

---

## Pass 1 — citation results

**Every command, exit code and number in report §1 reproduces exactly.** Re-run on 2026-08-26
with the stack up, exit status captured immediately after each command outside any pipe:

| Command | Reported | Reproduced |
|---|---|---|
| `pnpm format:check` | 0, `All matched files use Prettier code style!` | 0, identical |
| `pnpm lint` | 0, 14 tasks | 0, `14 successful, 14 total` |
| `pnpm typecheck` | 0, 14 tasks | 0, `14 successful, 14 total` |
| `pnpm test` | 0, 60 files / 786 tests | 0, `60 passed (60)` / `786 passed (786)` |
| `pnpm check:specs` | 0, 73 spec files | 0, `73 spec files, each claimed by exactly one of: unit, integration, ui` |
| `pnpm test:integration` | 0, 13 files / 169 tests | 0, `13 passed (13)` / `169 passed (169)` — twice |
| `pnpm build` | 0 | 0, `8 successful, 8 total` |
| `pnpm check:openapi` | 0, `routes: 4` | 0, `"routes":4` |
| `pnpm check:registry` | 0, 14 models / 3 / 1 / 10 | 0, string-identical |
| `docker compose ps` | four services `Up 11 hours (healthy)` | identical, mailpit on 1025 and 8025 |

Other claims, each checked directly:

- **§2 `git diff --stat main...HEAD -- pnpm-workspace.yaml packages/db/prisma/schema.prisma` is
  empty.** Confirmed. Carry-forward ruling 39 genuinely does not apply.
- **§3 nodemailer version and cooldown.** `npm view` returns `version = '9.0.5'`,
  `time.modified = '2026-08-07T09:36:04.091Z'` — matches. `apps/api/package.json` carries
  `nodemailer@^9.0.5` and `@types/nodemailer@^8.0.1` as a devDependency. No
  `minimumReleaseAgeExclude` entry exists.
- **§4 test-first.** Structurally verified at each commit rather than taken on trust: at `bb0dd09`
  `env.spec.ts` references `MAIL_SECURE` five times and `env.ts` zero; at `1cd9b0a` the emails
  directory contains four spec files and no implementation; at `1d0f6e2` the mail directory
  contains three spec files and no implementation, which arrives at `9dcf75f`.
- **§5 Mailpit was not emptied.** `MessagesDeleted 0` confirmed, and confirmed again across my own
  two extra runs. Recipients are `task05-<uuid>@sentinel.test` exactly as claimed.
- **§6 the delivered message.** Found in Mailpit and read back: subject, all four paragraphs, the
  `--` separator, both footer lines and the token (redacted here and in the report by the fix
  round — ruling 57)
  match the report **byte-for-byte**. `WEB_BASE_URL=http://localhost:3000` and
  `TOKEN_TTL_PASSWORD_RESET_SECONDS=3600` corroborate the origin and the "1 hour".
- **§7 commits.** 13 commits in range; all 13 carry
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Every listed SHA and subject matches.
- **§8 files created.** All **17** line counts are exact. `registry.spec.ts` was 319 at `5af8627^`
  and is 283 now — verified by `git show 5af8627^:… | wc -l`. Maximum file is 283 lines, so "every
  file is under the ~300-line limit" holds.
- **§9 files changed.** `.claude/product/roadmap.md` and `.claude/security/authentication.md` are
  both untouched on the branch — confirmed by empty diffstat. The table omits `CLAUDE.md` and
  `.claude/decisions/README.md`, which *are* changed in the range; both were changed by `083f9f0`,
  the pre-dispatch ADR commit, so the omission from an implementer's own change list is defensible
  and I do not count it as a false claim.
- **§12 J2.** `formatDuration(86_400)` returns `24 hours`; `3_600` → `1 hour`; `604_800` →
  `7 days`; `172_800` → `2 days`; `5_400` → `90 minutes`. Verified by execution.
- **§12 J3.** `check:openapi` reports 4 routes with `MailModule` registered. Verified.
- **Brief's line citations.** `infra/docker/docker-compose.yml:64` is `  mailpit:`;
  `.github/workflows/ci.yml:88` is `docker compose up -d --wait postgres redis minio mailpit`.
  Both exact.

**False or unsupported sentences found in the report: two.**

1. §14 — "**A seventh template — Task 15's — will fail `pnpm typecheck` until it is added there.**"
   False on both counts. The registry already has seven members and Task 15's invitation template
   is one of them. See M4.
2. §5 — "**`DELETE /api/v1/messages` appears in no file in this change.**" False as written; the
   string appears in three files as prose. The intended claim (never invoked) is true. See L4.

**§13's "not verified" list is accurate but not complete.** Two things are asserted without
qualification and are not true: the pooling rationale in `smtp-mailer.ts` and `smtp-mailer.spec.ts`
(M3, measurably false), and the implicit claim that the error path is token-safe, which the
redaction spec tests only against a synthetic error (M1). Everything the list *does* name — CI,
production relay, `MAIL_SECURE=true`, human mail-client rendering, ruling 51 being contract-only,
no retry/queue, `test:e2e`, and the 786/169 totals not being a delta — I checked and found stated
correctly.

**The two orchestrator claims this task rests on both hold.**
`git log --format='%H %ad %s' --date=iso main..HEAD` gives ADR-0016 (`083f9f0`) at
`2026-08-26 09:28:54`, the brief (`71c186d`) at `09:32:12`, and the first implementation commit
(`bb0dd09`) at `09:38:20`. The ADR precedes the brief, which precedes all implementation. The
brief has exactly one commit touching it and was never amended, so its twelve rulings were not
back-filled.

---

## Checked and found sound

Being specific here is what makes the rest of this review worth reading.

**Ruling 45 — delivered, and the strongest thing in this change.** I added a deliberately broken
eighth template (empty `text`, unescaped `recipientName`, an unreplaced `{{unreplaced}}`
placeholder, a `{{subject}}` in the subject, and a remote tracking `<img>`), registered it, and ran
the spec. **Eight assertions fired**, naming every planted defect:

```
FAIL > the email template registry > registers the six templates … require
FAIL > template brokenProbe > has a non-empty subject, html part and text part
FAIL > template brokenProbe > has a text part that is real prose, not stripped markup
FAIL > template brokenProbe > leaves no unreplaced placeholder in either part
FAIL > template brokenProbe > makes the recipient fetch nothing when the message is opened
FAIL > template brokenProbe > escapes an attacker-chosen display name into the html part
FAIL > notice template brokenProbe > carries no link of any kind, in either part
FAIL > notice template brokenProbe > names when it happened, in UTC
```

Removing it from `NOTICE_TEMPLATE_IDS` additionally fired
`classifies every template as either link-carrying or a notice`, so an unclassified template
cannot escape both rule sets. Removing it from `CASES` produced the promised compile error, not a
silent gap:

```
registry.spec.ts(49,7): error TS2741: Property 'brokenProbe' is missing in type
  '{ … }' but required in type 'Record<"passwordReset" | … | "brokenProbe", …>'.
```

A broken template does not pass. Ruling 45 is delivered in substance, not in name.

**Ruling 42 — no input reaches the origin.** `buildTokenLink` probed against eight base URLs and
ten hostile tokens. Path prefixes are preserved (`https://app.test/base` → `/base/reset-password`),
trailing slashes do not double, an existing `?next=//evil.test#frag` is discarded, and **every**
token — `a&b=c`, `a#b`, `a?b`, `a/b`, `%2Fevil`, `https://evil.test/`, `../../evil`, a space, and
non-ASCII — is percent-encoded, round-trips exactly through `searchParams.get('token')`, and leaves
`origin` and `pathname` unchanged. `links.ts` genuinely has no imports, and `links.spec.ts` asserts
that against the source text with comments stripped first, plus `buildTokenLink.length === 3`.

**Ruling 48 — the pairing rule is reachable and the restructure did not break the existing one.**
Measured against a real `.env`:

- username without password → refused, naming `MAIL_PASSWORD`.
- password without username → refused, naming `MAIL_USERNAME`; `LEAKS_PW=false` in both
  `err.message` and `err.stack`.
- **both rules broken at once → both reported**:
  `VARS=["MAIL_USERNAME","PASSWORD_ARGON2_MEMORY_KIB","PASSWORD_ARGON2_PARALLELISM"]`. Deviation
  D3 is accurate and the Argon2 refinement still fires.
- `MAIL_USERNAME=` (empty) → refused with `must be at least 1 character(s)`.
- both set → accepted, `MAIL_SECURE` defaulting to `false`.

`load-env.ts` never reads `issue.message` and never reads `received` for the issue codes that
carry raw input, so no configuration value reaches the boot error text.

**Ruling 49 — proven at the application level, not just the module.** I booted the real
`apps/api/dist/main.js` with `MAIL_HOST=127.0.0.1 MAIL_PORT=1` (nothing listening) and hit the
health endpoint:

```
PATH=/health/live STATUS=200 BODY={"status":"ok"}
```

`grep -rn "verify(" apps/api/src/infrastructure/mail/` finds the method only as an interface
declaration and in comments — no call site anywhere. No `onModuleInit`. And the connection counter
showed `CONNECTIONS_AFTER_CONSTRUCT=0`, so construction genuinely opens nothing.

**Ruling 50 — proven against a dirty mailbox.** I ran `pnpm test:integration` twice back to back
without clearing Mailpit, starting from a mailbox already holding 18 messages (including ones my
own probes had added):

```
before: Messages 18  MessagesDeleted 0  SMTPAccepted 18
RUN 1:  EXIT1=0      13 files / 169 tests passed
after:  Messages 23  MessagesDeleted 0  SMTPAccepted 23
RUN 2:  EXIT2=0      13 files / 169 tests passed
after:  Messages 28  MessagesDeleted 0  SMTPAccepted 28
```

The spec depends on neither emptiness, nor ordering, nor a count; it finds its own message by a
per-case UUID recipient and reads nothing it did not send. `MessagesDeleted` stayed 0 throughout.
This is the defect ruling 50 exists to prevent, and it is genuinely prevented.

**Ruling 47 — the adapter's own logging is clean.** Failure paths A (ECONNREFUSED), B (implicit
TLS against a plaintext server) and C (a relay quoting the reset URL) all showed
`LEAKS_SENTINEL=false`. The logged object is exactly `templateId`, `recipient`, `messageId` /
`err`, and binding `context` before the `try` does what its comment says. The positive control in
`mail.redaction.spec.ts` is the right instinct — without it an adapter that logged nothing would
pass every negative assertion. M1 is a hole in the backstop, not in this.

**A relay password does not leak on auth failure.** A server answering `535 5.7.8 Authentication
credentials invalid` produced `LEAKS_PASSWORD=false`; nodemailer's error carries `response`,
`responseCode` and `command: 'AUTH PLAIN'` but not the credential.

**Ruling 44 in the reachable direction.** Every interpolation site in `layout.ts` calls
`escapeHtml` — `paragraphsHtml`, `footerHtml`, `<title>`, `<h1>`, and both the label and the URL in
`actionHtml`. Measured, both quote characters are escaped in both quoting styles, so the
attribute-breakout path is closed. `registry.spec.ts`'s quote-count assertion (an attacker-chosen
value contributes no `"` to the markup at all) is a better test than matching the payload and its
comment explains why the obvious version was wrong.

**Rulings 43, 46, 51 and 52.** nodemailer 9.0.5 is well past ADR-0013's cooldown and installed
without an exclusion. Ruling 46 is asserted over the whole registry (`<img`, `src=`, `<link`,
`@import`, `url(`, `background=`) rather than per template. Ruling 51 is stated in the port's
docblock with the alternative it was chosen against, and — correctly — is demonstrated by no test,
exactly as the brief required. Ruling 52's integration spec uses the real adapter and real
nodemailer with no third constructor argument, parses the link with `new URL()` and reads
`searchParams.get('token')` rather than matching a substring, and asserts both parts as Mailpit
reports them.

**`integrations.md` §7** states the shipped port signature correctly, names ADR-0016 and the real
file paths, does **not** mark the document Implemented, and states the no-retry/no-queue gap
plainly rather than implying it. It is the most careful prose in the change.

**Nothing in this change breaks an existing spec's assumptions** — all three suites are green from
a clean checkout at `147e61c`.

---

## Working tree

Two experiments mutated the tree: the broken-template probe (`registry.ts`, `registry.spec.ts`, a
new `broken.probe.ts`) and four temporary probe spec files. All were restored from byte-copies
taken before the mutation and the new files deleted.

`schema.prisma` was **never opened**, so carry-forward ruling 39's `prisma generate` does not
apply — and `pnpm check:registry` passing afterwards ("DMMF verified against
`packages/db/prisma/schema.prisma`") independently confirms the generated client is unmutated,
which a clean `git status` alone would not.

Final state:

```
$ git status --short
(no output)

$ git diff --stat HEAD
(no output)
```
