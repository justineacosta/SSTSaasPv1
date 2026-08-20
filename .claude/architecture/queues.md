# Queue architecture

> **Status: Designed. Not Implemented.** Phase 4.
> Decision record: [ADR-0004](../decisions/ADR-0004-queue-architecture.md).

BullMQ on Redis 7.

## 1. Queues

Separate queues, not one queue with priorities — a slow class must not block a fast one, and
each has a different concurrency profile and failure policy.

| Queue | Work | Concurrency | Timeout |
|---|---|---|---|
| `scan:web` | Web security scans | Per worker pool | 30–120 min |
| `scan:api` | API security scans | Per worker pool | 30–120 min |
| `scan:analysis` | SAST, dependency, container (Phase 12) | Per worker pool | 60 min |
| `report` | Report generation | 4 | 10 min |
| `notification` | Email and in-app fan-out | 20 | 30 s |
| `webhook` | Outbound delivery | 20 | 30 s |
| `integration` | Jira, GitHub, Slack sync | 10 | 60 s |
| `maintenance` | Retention, rollups, SLA sweep, verification re-check | 2 | 30 min |

## 2. Payloads

Minimal, and never authoritative:

```jsonc
{ "scanId": "scn_01J...", "organizationId": "org_01J...", "requestId": "req_01J..." }
```

The worker re-reads everything else from the database. `organizationId` is included **only
so the worker can assert it matches** what it loads — a mismatch means a bug or a forgery
attempt and fails loudly. Payloads never carry credentials, scope rules, or entitlements,
because all three can change between enqueue and execution and the stale copy would be the
one that ran.

## 3. Idempotency

Jobs use a deterministic ID (`scan:{scanId}`) so a duplicate enqueue is a no-op. Handlers are
idempotent regardless: state transitions use compare-and-set, occurrence inserts have a
unique constraint, and webhook deliveries carry a delivery ID the receiver can dedupe on.
At-least-once delivery is assumed, because it is what Redis actually provides.

## 4. Retry policy

| Queue | Attempts | Backoff |
|---|---|---|
| `scan:*` | 3 (transient causes only) | 30s, 2m, 8m + jitter |
| `report` | 3 | 10s, 1m, 5m |
| `notification` | 5 | exponential from 5s |
| `webhook` | 8 | 10s → 24h, exponential + jitter |
| `integration` | 5 | exponential from 30s |
| `maintenance` | 2 | 5m |

**Authorization, scope, and entitlement failures are never retried** — the refusal was
correct. Exhausted jobs move to a dead-letter queue, which is monitored and alerted on rather
than being a place jobs go to be forgotten.

## 5. Fairness

A single tenant must not monopolise the queue. Per-organisation concurrency limits come from
`maxConcurrentScans`; a weighted-fair dispatcher round-robins across organisations with
pending work rather than draining the queue in insertion order. Scans held by the org cap
remain `QUEUED` and are shown to the user as queued with position, not failed.

## 6. Redis operations

Persistence: AOF with `everysec`. **Queue state is durable-ish, not authoritative** — the
database is the source of truth, and every job can be reconstructed from a scan row. Loss of
Redis loses in-flight queue position, not data; the scheduler re-enqueues scans stuck in
`QUEUED` past a threshold. Separate logical databases (or key prefixes) for queue, cache,
rate limiting, and pub/sub so a `FLUSHDB` on one cannot take the others. Memory policy is
`noeviction` on the queue database — evicting a job is data loss.

## 7. Observability

Per queue: depth, oldest job age, throughput, failure rate, dead-letter count, processing
duration percentiles. Alerts on: depth above threshold, oldest job age exceeding SLA, failure
rate spike, any dead-letter arrival, and worker heartbeat loss. Job logs carry the originating
`requestId` so a queued side effect can be traced back to the request that caused it.
