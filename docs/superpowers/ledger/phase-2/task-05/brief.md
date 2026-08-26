# Phase 2 · Task 5 — Mail infrastructure and templates · implementer brief

> **A dated record of what was said and decided at the time. Not a description of current state —
> [`roadmap.md`](../../../../../.claude/product/roadmap.md) is the only authority on that.**

Dated 2026-08-26. Written by the orchestrator before dispatch. Plan section: Task 5 in
[`../../../plans/2026-08-24-phase-2-identity.md`](../../../plans/2026-08-24-phase-2-identity.md).
Branch: `feat/phase-2-task-05`, cut from `main` at `c641b9d`. **ADR-0016 is already committed**
(`083f9f0`) — read it first; it is the decision this task implements, not a document written
afterwards.

## What you are building

A `Mailer` port with one SMTP adapter, six email templates behind it, and an integration test that
reads the delivered messages back out of Mailpit over HTTP.

**You are not building an endpoint.** Nothing in this task is reachable over the network. Six
templates and a transport, provided to the endpoint tasks that follow — registration (Task 8),
password reset (Task 10), MFA (Task 11), invitations (Task 15). `pnpm check:openapi` must still
report **4 routes** when you are finished; that is the check which proves you did not ship a route.

## Deliverables

1. **`apps/api/src/infrastructure/mail/`** — the port, the SMTP adapter, the Nest module, DI tokens.
2. **`apps/api/src/modules/auth/emails/`** — six templates and their shared layout.
3. **Unit specs** for rendering, escaping, and link construction.
4. **One integration spec** that sends through the real adapter to the compose Mailpit and reads
   the message back over Mailpit's HTTP API.
5. **`.claude/architecture/integrations.md`** updated — see _Doc ownership_ below.

## The six templates

Per plan, and per `security/authentication.md` §2, §5 and §6. Three carry a token link; three are
notices that carry no token at all and exist so an account takeover is visible to its victim.

| Template                     | Carries a link | Source requirement                                                                             |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Email verification           | yes — `?token=` | §6, 24h TTL                                                                                     |
| Password reset               | yes — `?token=` | §6, 1h TTL                                                                                      |
| Invitation                   | yes — `?token=` | §6, 7d TTL                                                                                      |
| Password changed             | no             | §2 "Password change and reset revoke all other sessions and email the user"                     |
| MFA enabled / disabled       | no             | §5 "Enabling or disabling MFA … emails the user"                                                |
| New sign-in from a new device | no            | §7 "a burst notifies the account owner"                                                          |

MFA enabled and MFA disabled may be one template taking a discriminator or two templates. Your
call; whichever you pick, both states must be reachable and both must be asserted.

## Rulings taken before dispatch

These are decisions already made. **A ruling is a floor, not a ceiling** — if you find a better
answer, take it and say so in your report with the reason. What you may not do is silently ignore
one.

**Ruling 41 — the secret travels as `?token=` on a query string. Not a path segment.**
This is carry-forward rulings 34 and 36 landing on the task that owns the link format. Task 4
measured the redacting logger against four shapes carrying a real 256-bit token: only the one under
a denylisted key name was redacted. `key` and `code` were then deliberately _removed_ from the
value-shape pattern's name list, because `redact()` blanks the whole field on a match and both
names collide with this product's own object-storage URLs and its SCREAMING_SNAKE error codes. A
token in a **path segment** (`/verify/<token>`) is covered by nothing and was measured leaking
verbatim. So: `${WEB_BASE_URL}/verify-email?token=<value>`, and the same shape for reset and
invitation. **Cost if wrong:** a link format is cheap to change today and expensive once it is in a
user's inbox and a Task 16 screen.

**Ruling 42 — links are built from `WEB_BASE_URL` only, and the builder must be incapable of seeing
a request.** Not "should not" — _cannot_. The link builder takes a base URL and a token and nothing
else; no request object, no headers, no `Host`. A host-header-derived reset link is a well-known
account-takeover primitive, and the way it gets introduced is a helper that has a request in scope
and takes the convenient value. Add a spec asserting the origin is `WEB_BASE_URL`'s and that no
attacker-supplied host can reach the function. **Cost if wrong:** every reset link in the product
becomes an attacker-chosen origin.

**Ruling 43 — `nodemailer` is the SMTP client.** Add it to `apps/api` dependencies, with
`@types/nodemailer` as a devDependency. It is the mature SMTP client in this ecosystem, and
hand-rolling SMTP to avoid a dependency would be a far worse trade. ADR-0013's 24-hour release-age
cooldown applies; nodemailer's current release is well past it, so this should install without
touching `minimumReleaseAgeExclude` — **and if it does not, stop and report rather than adding an
exclusion.** That block has been written and removed once already on this repository, and ADR-0013
exists because of it.

**Ruling 44 — templates are TypeScript functions, not a template engine.** No Handlebars, no MJML,
no EJS. Each template is a function taking a typed input and returning `{ subject, html, text }`.
The reason is that HTML escaping is the security control here, and a function forces an explicit
escape call at each interpolation, where an engine's auto-escaping becomes a property you assume
and stop testing. Write one `escapeHtml` and use it on **every** interpolated value in an `html`
part, including ones you believe are safe. Add a spec that puts `<script>alert(1)</script>` and a
`"` into a display name and asserts neither survives into the `html` part unescaped. **Cost if
wrong:** a display name is attacker-controlled, and an unescaped one is stored XSS in whatever
webmail client renders it.

**Ruling 45 — the templates live behind a registry, and the "both parts" rule is enforced over that
registry.** Do not write six near-identical assertions. Build an exported registry — a record of
template id to renderer — and write a table-driven spec that iterates it and asserts, for every
member: a non-empty `subject`, a non-empty `html`, a non-empty `text`, that the `text` part is not
merely the HTML with its tags stripped to emptiness, and that no unreplaced placeholder survives in
either part. A seventh template added in Task 15 then inherits every assertion by existing. **Cost
if wrong:** six templates each tested slightly differently is how one of them ships without a text
part.

**Ruling 46 — no remote assets, no tracking pixel, no external stylesheet.** Inline CSS only, no
`<img src="https://…">`, nothing that makes the recipient's mail client fetch from us. A security
product that opens a tracking beacon in its own security-notice emails is making the argument
against itself, and a remote image is also the standard read-receipt side channel. **Cost if
wrong:** low technically, high in credibility.

**Ruling 47 — the adapter never logs a rendered body, and never logs the token.** Log the template
id, the message id the server returned, and the recipient. Never `html`, never `text`, never the
link. Three of the six bodies contain a live credential, and ruling 41's redaction pattern is the
_second_ line of defence, not the first. Add a spec in the shape of the existing
`token.redaction.spec.ts` that runs a send through a capturing logger and asserts a known token
value appears nowhere in the captured output. **Cost if wrong:** the exact defect Task 4 measured
and fixed, reintroduced one layer up.

**Ruling 48 — SMTP authentication and TLS are configured, because ADR-0016 claims production works
through this adapter.** Add `MAIL_USERNAME`, `MAIL_PASSWORD` (both optional, no default) and
`MAIL_SECURE` (boolean, default `'false'`) to `apiEnvSchema`. **Carry-forward ruling 30: that schema
is a `ZodEffects` — add them inside the base object, before the refinement**, next to the existing
`MAIL_HOST` / `MAIL_PORT` / `MAIL_FROM`. Auth is passed to nodemailer only when both username and
password are present; `secure: false` on port 1025 is correct for Mailpit and lets nodemailer
STARTTLS on 587 where a relay offers it. Refuse a configuration carrying one of username/password
but not the other — that is a misconfiguration worth crashing at boot over rather than silently
sending unauthenticated. **Cost if wrong:** three environment variables nothing sets today. Without
them, ADR-0016's claim that the same adapter serves production is false, and that is the worse
cost.

**Ruling 49 — the mailer does not verify its connection at boot.** No `transporter.verify()` in a
constructor or an `onModuleInit`. The API must boot with the mail server down; mail is not on the
liveness path, and an unreachable relay must not stop the service that serves everything else. A
failed send raises at send time. **Cost if wrong:** an SMTP outage becomes an API outage, when the
health endpoints already exist to report degradation without refusing to start.

**Ruling 50 — the integration spec must not delete other specs' messages.** This is carry-forward
ruling 33 pointed at Mailpit. `rate-limit.integration.spec.ts` deleted a Redis namespace another
spec was writing to, its comment claimed the narrowing "protects other suites", and it did not —
that cost this project a session. Mailpit is one shared container with one shared mailbox, and its
API offers `DELETE /api/v1/messages`, which deletes **everything**. Do not call it in a
`beforeEach`, and do not call it at all unless you can show it reaches only your own messages.
Instead give every test case a unique recipient — a fresh random local part per case — and find your
message by searching for that address. The spec is then correct even if it is one day run in
parallel with another that sends mail. **Cost if wrong:** a flake that appears only when a second
mail-sending spec is added, months from now, in a task that has nothing to do with mail.

**Ruling 51 — sending happens after commit, outside the transaction, and in this task that can only
be a written contract.** No endpoint exists to demonstrate it. State the rule in the port's docblock
and state _which_ alternative you chose against and why: a send inside the transaction either holds
a database transaction open across network I/O to a third party, or — worse — sends "your password
was changed" for a change that then rolls back. The second is the one that decides it: an email is
not transactional and cannot be recalled. **Do not simulate a caller to make this look tested.** It
binds Tasks 8, 10, 11 and 15, and it goes into this task's rulings file so those briefs inherit it.
**Cost if wrong:** the wrong pattern gets copied by the first endpoint that sends mail, which is
Task 8.

**Ruling 52 — the integration spec sends through the real adapter to the real Mailpit over real
SMTP.** Not a mock transport, not nodemailer's `jsonTransport`, not a stub. The plan's words are "a
mock here would be mocking the thing under test", and this is the deliverable of the task. Assert
the recipient, the subject, and that the body contains a link matching the expected route with a
`token` query parameter — parse it with `new URL()` and read `searchParams.get('token')` rather
than matching a substring, so the assertion is about a real URL. Assert the message has **both** a
text part and an HTML part as Mailpit reports them. **The compose stack reaches Mailpit through the
root `.env`**, the way `rate-limit.integration.spec.ts` reaches Redis — you do **not** need
`startPostgresHarness()` here, because this task touches no table. Mailpit's HTTP API is on
`http://127.0.0.1:8025`; `infra/docker/docker-compose.yml:64` is the service definition, and CI
already starts it (`.github/workflows/ci.yml:88`).

## Constraints you inherit and must not relitigate

- **ESM, Node 26, strict TypeScript** with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any` without a written justification comment.
- **`process.env` only inside `packages/config`.** The adapter takes its configuration injected.
- **No `console.log`.** The redacting logger from `@sentinel/observability` is the only logger.
- **Files under ~300 lines.** Six templates plus a layout will not fit in one file; do not try.
- **Conventional commits**, each ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Carry-forward ruling 40:** `pnpm test` and `pnpm lint` can both be green while `pnpm typecheck`
  is not. Run all three.
- **Carry-forward ruling 39:** if you touch `schema.prisma` at all — you should not need to — run
  `prisma generate` after reverting. A clean `git status` is not evidence that you did.

## Doc ownership

`.claude/architecture/integrations.md` is yours in this change. It currently opens
"**Status: Designed. Not Implemented.** Phase 9." and its provider table has no mail row. Mail is
not one of that document's Phase 9 provider integrations and must not be filed as one — it is
infrastructure the API calls directly, with no outbox, no dispatcher and no connection record. Add
a short section saying exactly that, naming the port, naming ADR-0016, and stating that the Phase 9
abstraction does not cover it. **Do not** mark the document Implemented; nothing in Phase 9 is
built.

`.claude/security/authentication.md` §6 needs no change — it describes the token discipline, which
you are not altering. If you find yourself wanting to edit it, stop and report why instead.

## Verification

`sentinel-verify`'s list, with the compose stack up. `pnpm test:e2e` is out of scope — this task
touches no `apps/web` path and can reach no rendered page. `pnpm check:openapi` and
`pnpm check:registry` are both in scope: the first proves you shipped no route, the second proves
you added no table.

## Reporting rules

**Commands and exit codes, not prose.** No status sentences, no `roadmap.md` edits, no `.claude/`
narrative beyond the `integrations.md` section named above. The orchestrator writes every sentence
that asserts anything about what works.

Report every deviation from a ruling above with its reason. Report anything you could not verify,
and say plainly that you could not verify it — an unverified claim about this repository is a false
claim whether or not you meant it, and that is the defect class this phase's process exists to
catch.
