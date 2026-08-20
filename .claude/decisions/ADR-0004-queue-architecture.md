# ADR-0004 — BullMQ on Redis, with database-authoritative job state

**Status:** Accepted · **Date:** 2026-08-20

## Context

Scans, reports, notifications, webhook deliveries, integrations, and maintenance all need
asynchronous execution with retries, timeouts, cancellation, concurrency control, and
per-tenant fairness. We already require Redis for caching, rate limiting, and realtime pub/sub.

A specific constraint shapes this decision: a queued scan job authorises real network traffic
against a third party. Anything stale in the payload — scope, entitlements, verification status,
cancellation — could cause traffic that is no longer authorised.

## Decision

**BullMQ on Redis 7**, with separate queues per work class, and one overriding rule:

> **The database is authoritative for job state. The queue only carries identifiers.**

Payloads contain `scanId`, `organizationId`, and `requestId`, nothing more. `organizationId` is
present **only so the worker can assert it matches the record it loads** — a mismatch fails
loudly as a bug or forgery. Everything else is re-read from Postgres at execution time.

Queues are separated by class (`scan:web`, `scan:api`, `scan:analysis`, `report`,
`notification`, `webhook`, `integration`, `maintenance`) rather than sharing one queue with
priorities, so a slow class cannot block a fast one and each gets its own concurrency and
retry policy.

## Alternatives considered

**A database-backed queue (`SELECT ... FOR UPDATE SKIP LOCKED`).** Genuinely attractive: one
fewer moving part, and jobs become transactional with the writes that create them. Rejected
because polling adds latency and load, and because we need Redis anyway for rate limiting and
realtime — so it would be a second queueing mechanism, not one fewer system. The transactional
benefit is recovered by the outbox pattern for events and by after-commit enqueue.

**SQS / Cloud Tasks.** Rejected. Provider lock-in, worse local development, and weaker support
for the concurrency and fairness controls we need per tenant.

**Kafka.** Rejected. It is an event log, not a job queue. We need per-job retry, cancellation,
and visibility timeouts, which Kafka does not provide naturally.

**Rich payloads carrying scope and entitlements.** Explicitly rejected, and this is the most
important part of the decision. Time passes between enqueue and execution. Scope narrows,
assets are deleted, organisations are suspended, subscriptions lapse, scans are cancelled. A
payload snapshot would be exactly the stale authorisation we must not act on.

## Consequences

**Positive.** Mature retry, backoff, rate limiting, and concurrency primitives. Good local
development. Redis loss is survivable — job state is reconstructible from the database, and the
scheduler re-enqueues anything stuck in `QUEUED`. Thin payloads mean no sensitive data sits in
Redis. Per-queue policies keep classes independent.

**Negative.** Redis is another system to operate and monitor. At-least-once delivery means every
handler must be idempotent — enforced through deterministic job IDs, compare-and-set transitions,
and unique constraints on occurrence inserts. Re-reading state per job costs an extra database
round trip, which is trivially worth it.

**Neutral.** Redis persistence is AOF `everysec`; queue state is durable-ish, not authoritative,
and the design assumes that explicitly rather than depending on it.
