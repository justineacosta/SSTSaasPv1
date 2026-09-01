# Architecture Decision Records

A record of significant, hard-to-reverse decisions: what we chose, what we rejected, and what it
costs us. The rejected alternatives are the most valuable part — they stop a decision being
re-litigated every six months by someone who cannot see why the obvious option was not taken.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](ADR-0001-overall-architecture.md) | Modular monolith with detached workers | Accepted |
| [0002](ADR-0002-postgresql-and-prisma.md) | PostgreSQL and Prisma | Accepted |
| [0003](ADR-0003-worker-isolation.md) | Engine isolation in ephemeral containers | Accepted |
| [0004](ADR-0004-queue-architecture.md) | BullMQ on Redis, database-authoritative job state | Accepted |
| [0005](ADR-0005-authentication-model.md) | Opaque server-side sessions, not JWTs | Accepted |
| [0006](ADR-0006-multi-tenant-isolation.md) | Shared database, mandatory scoping, RLS second layer | Accepted |
| [0007](ADR-0007-evidence-storage.md) | Evidence in object storage, metadata in Postgres | Accepted |
| [0008](ADR-0008-billing-architecture.md) | Stripe as authority, entitlements as projection | Accepted |
| [0009](ADR-0009-scope-enforcement.md) | Proof of ownership and double scope evaluation | Accepted |
| [0010](ADR-0010-engine-contract.md) | Language-agnostic engine contract over stdio | Accepted |
| [0011](ADR-0011-prefixed-uuidv7-identifiers.md) | Prefixed UUIDv7 identifiers, generated in application code | Accepted |
| [0012](ADR-0012-node-26-runtime-pin.md) | Node 26 pinned for development and CI, engines >= 22 | Accepted |
| [0013](ADR-0013-dependency-release-age-cooldown.md) | A 24-hour release-age cooldown on every dependency, declared explicitly | Accepted |
| [0014](ADR-0014-argon2-implementation.md) | Argon2id via `@node-rs/argon2`, parameters held in configuration | Accepted |
| [0015](ADR-0015-password-breach-check-fails-open.md) | The password breach check calls HIBP by k-anonymity, and fails open | Accepted |
| [0016](ADR-0016-smtp-mailer-port.md) | One `Mailer` port with an SMTP adapter; Resend is deferred until a deploy exists | Accepted |
| [0017](ADR-0017-cors-allowlist-with-credentials.md) | The browser reaches the API directly, under an explicit CORS allowlist with credentials | Accepted |
| [0018](ADR-0018-pending-mfa-session-row.md) | The pending MFA credential is a `Session` row in `PENDING_MFA` status, not a Redis-only token | Accepted |
| [0019](ADR-0019-platform-audit-events.md) | Actions with no organisation are audited in a separate `PlatformAuditEvent` table | Accepted |

**0018 was claimed out of order and is now written.** It was reserved for the pending-MFA
credential decision while Phase 2 Task 9 shipped that credential provisionally; Phase 2 Task 11
took the decision and wrote it. Numbers are claimed when a decision is taken, and Task 8's was
taken first, which is why 0019 was written before 0018.

## When to write one

Write an ADR when a decision is expensive to reverse, when it constrains future work, when a
reasonable engineer would ask "why on earth is it like this?", or when you rejected an obvious
option for a non-obvious reason.

Do not write one for a decision that is easy to change later. That is just code.

## Format

```markdown
# ADR-NNNN — Title stating the decision, not the topic

**Status:** Proposed | Accepted | Superseded by ADR-NNNN · **Date:** YYYY-MM-DD

## Context
The forces at play. What makes this hard.

## Decision
What we are doing. Present tense, specific.

## Alternatives considered
Each option, and why it lost. Be fair to the ones you rejected.

## Consequences
Positive, negative, and neutral. Name the costs honestly —
an ADR listing only benefits is marketing, not a record.
```

## Rules

Numbers are sequential and never reused. An ADR is **immutable once accepted**: to change a
decision, write a new ADR and mark the old one `Superseded by ADR-NNNN`. Editing history to
match current opinion destroys the only thing this directory is for.

The title states the decision (`Opaque server-side sessions, not JWTs`), not the topic
(`Authentication`) — so the index is readable without opening anything.
