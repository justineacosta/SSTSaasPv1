# ADR-0016 — One `Mailer` port with an SMTP adapter; Resend is deferred until a deploy exists

**Status:** Accepted · **Date:** 2026-08-26

## Context

Phase 2 cannot ship registration (Task 8), password reset (Task 10), MFA notices (Task 11) or
invitations (Task 15) without sending mail. [`security/authentication.md`](../security/authentication.md)
§6 makes email the **only** delivery channel for all three token kinds, and §2 and §5 additionally
require notice emails — password changed, MFA enabled or disabled — that carry no token at all and
exist purely so an account takeover is visible to its victim.

`CLAUDE.md`'s tech-stack table names **Resend** as the email provider, and that is where this
decision starts rather than ends. Resend is an HTTP API requiring an API key and a verified sending
domain. This product has neither, because **nothing is deployed**: `roadmap.md` records that no
request reaches this code from outside a test or a developer's machine. A Resend adapter written
today could not be run, could not be tested against anything real, and could not be verified.

`CLAUDE.md`'s honesty rule is explicit that a file which exists is not a feature that works. An
adapter with no credentials and no verified domain is precisely that: unverified code claiming to
be a provider integration. It would sit in the tree accumulating the appearance of support for a
service nobody has ever successfully sent a message through.

Meanwhile the local stack has run Mailpit since Phase 1 — `infra/docker/docker-compose.yml:64`,
SMTP on 1025, an HTTP API and UI on 8025, healthchecked — and `MAIL_HOST`, `MAIL_PORT` and
`MAIL_FROM` have been required, validated environment variables in `packages/config` since the same
phase. The infrastructure for real, assertable mail delivery is already present and already green
in CI, where `.github/workflows/ci.yml:88` starts `mailpit` alongside Postgres, Redis and MinIO.

## Decision

**One `Mailer` port, one adapter, and that adapter speaks SMTP.**

The port is a single-method interface — `send({ to, subject, html, text })` — depended on by name
through a Nest injection token. No caller anywhere in the codebase knows what is behind it.

The only implementation in Phase 2 is an SMTP adapter configured from `MAIL_HOST`, `MAIL_PORT` and
`MAIL_FROM`. Locally and in CI those point at Mailpit, which means **every email this product sends
during Phase 2 is a real SMTP message**, visible in a UI a human can open and assertable in an
integration test through Mailpit's HTTP API. In staging and production the same adapter points at
whatever SMTP relay that environment provides, including Resend's own SMTP endpoint.

**The Resend HTTP adapter is deferred, and its trigger is named: the first staging deploy.** That
is the first moment an API key and a verified sending domain exist, and therefore the first moment
the adapter can be run rather than merely written. Adding it is additive — a second class behind
the same port and a factory that chooses between them — and touches no template and no caller.

## Alternatives considered

**Write the Resend adapter now, behind a feature flag.** Rejected on the honesty rule. The flag
would default off in every environment that exists, so the code would ship untested by anything
except a mock of the very transport under test. ADR-0015 records the same trap from the other
direction: the breach check is env-flagged and off by default, but it has a real HTTP client that
was exercised against a real k-anonymity contract. There is no equivalent here — there is no
Resend account.

**Write both adapters and select by environment.** Rejected as the same code with more machinery.
The selection factory is genuinely small; it is the *adapter* that cannot be verified, and adding a
factory around an unverifiable class does not make it verifiable.

**Skip the port; call an SMTP library directly from the services.** Rejected because the deferral
above is only cheap if the seam exists. Six template call sites reaching into a transport directly
is six edits when the provider changes, and it puts network I/O in the same file as domain logic.
The port costs one interface and one token.

**Use Resend's SMTP endpoint in production and call it a Resend integration.** This is in fact
what the decision permits, and it is worth stating plainly rather than dressing up: SMTP against a
relay is a legitimate production configuration, not a stopgap. What it does not give is Resend's
HTTP-only features — delivery webhooks, per-message tagging, the analytics dashboard. If any of
those becomes a requirement, that is a second trigger for the deferred adapter.

## Consequences

**Positive.** Every email in Phase 2 is a real message over a real protocol, delivered to a real
server, and asserted by reading it back over Mailpit's HTTP API rather than by asserting that a
mock was called. That is the difference between testing the mailer and testing a spy of it. CI
needs no external account, no secret, and no network egress to a third party, so the mail tests
cannot flake on someone else's availability and cannot leak a key. A developer can open
`http://localhost:8025` and read exactly what a user would receive, which is the only way template
defects — a broken link, an unrendered variable, an unreadable text part — are actually caught.

**Negative.** SMTP is a chattier protocol than an HTTP API and a production relay will need
connection-level tuning this phase does not do: no connection pooling, no retry policy, no
backoff, and no dead-letter path. **A failed send in Phase 2 raises and is logged; it is not
retried and it is not queued.** For a verification email that is survivable, because the user can
request another one, and Task 8 must therefore ship a resend path rather than treating the first
send as authoritative. For a notice email — "your password was changed" — a silent failure means
the security signal the notice exists to deliver never arrives, and nothing detects that. Phase 4
brings BullMQ, and mail delivery belongs on a queue with retries at that point; until then this is
a real, named gap rather than an oversight.

**Negative.** `CLAUDE.md`'s stack table says Resend, and this decision makes that table aspirational
for the duration. The table is updated to say so in the same change, because a stack table that
names a provider nothing talks to is the same defect class this ADR exists to avoid.

**Neutral.** The deferral is reversible at low cost by construction: a second class behind the port
and a factory. Nothing about the templates, the callers, or the tests changes when it lands. The
cost of being wrong about the deferral is therefore roughly one file, paid on the day someone has
credentials to test it with — which is the day it can be verified, and not before.
