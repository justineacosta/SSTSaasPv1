# Worker architecture

> **Status: Designed. Not Implemented.** Phase 4.
> Security controls: [`../security/worker-security.md`](../security/worker-security.md) ·
> [ADR-0003](../decisions/ADR-0003-worker-isolation.md).

## 1. Worker types

| Worker | Runtime | Consumes | Responsibility |
|---|---|---|---|
| `worker-node` | Node | `scan:web`, `scan:api`, `report`, `notification`, `webhook`, `integration` | Orchestrate TypeScript engines and platform jobs |
| `worker-python` | Python | `scan:analysis` | Orchestrate Python engines |
| `scheduler` | Node | Produces to `maintenance` | Leader-elected periodic work |

Workers **orchestrate**; engines **execute**. The separation is the security boundary: a
worker holds credentials, an engine holds none.

## 2. Worker responsibilities

Reserve a job, re-validate it against the database, resolve and deny-list-check targets,
launch and supervise the engine container, consume its event stream, normalise/verify/dedupe
findings, upload evidence, compute risk, persist transactionally, publish realtime events,
and guarantee cleanup. Detail: [`../scanners/execution.md`](../scanners/execution.md).

What a worker never does: trust the job payload, execute anything not pre-authorised, hold
credentials for anything beyond its own needs, or hand the Docker socket to an engine.

## 3. Container execution

Workers do not call the Docker API directly. They call an **execution service** with a narrow
interface — run this image, with this input, these limits, this network policy — which
returns a stream and guarantees teardown. Two reasons: a worker compromise does not become
host root, and the runtime becomes swappable (Docker locally, Kubernetes Jobs or Fargate in
production) without touching worker logic.

## 4. Scheduler jobs

Leader-elected through a Redis lock with a TTL and heartbeat renewal, so running multiple
instances is safe and failover is automatic.

| Job | Cadence | Purpose |
|---|---|---|
| SLA sweep | 15 min | Mark breaches, notify |
| Stuck scan sweep | 5 min | Fail scans past timeout + grace |
| Asset verification re-check | Daily | Re-verify ownership; expire lapsed |
| Auto-resolution sweep | Daily | Resolve findings not seen by qualifying scans |
| Retention enforcement | Daily | Expire findings, evidence, audit, reports per plan |
| Usage rollup | Hourly | Aggregate `UsageRecord`, report metered usage to Stripe |
| Webhook retry | 1 min | Redrive failed deliveries |
| Storage reconciliation | Weekly | Detect orphans in both directions |
| Scheduled scans | 1 min | Enqueue due recurring scans |
| Session and token cleanup | Hourly | Purge expired rows |

## 5. Scaling

Workers scale horizontally on queue depth and oldest-job age. They are stateless: all state
is in Postgres and Redis, so an instance can be killed at any moment. Graceful shutdown
drains in-flight jobs within a timeout, then releases them for reclaim rather than failing
them.

Sizing is driven by *concurrent engine containers*, not request rate: each container reserves
its declared CPU and memory for its lifetime, so a worker host's capacity is
`min(cpu, memory) / per-container reservation`.

## 6. Failure modes

| Failure | Behaviour |
|---|---|
| Worker crash mid-job | Job reclaimed after visibility timeout, re-validated from scratch |
| Container fails to start | Retried as transient |
| Engine crash | Scan `FAILED` with partial results; not auto-retried |
| Engine hangs | Worker's independent timer kills it; `TIMED_OUT` |
| Worker cannot reach the database | Job not acknowledged; released for reclaim |
| Storage unavailable | Evidence upload retried; scan fails rather than recording findings with missing evidence |
| Redis unavailable | Workers idle and retry; scans stay `QUEUED`; the scheduler redrives on recovery |
| Orphaned container | Reaper sweeps by label and age |

The storage rule is deliberate: a finding whose evidence silently failed to upload is worse
than a failed scan, because it looks trustworthy and is not.

## 7. Observability

Structured logs with `jobId`, `scanId`, `organizationId`, `engineId`, and the originating
`requestId` — never target response bodies, never credentials. Metrics: jobs processed by
queue and outcome, duration percentiles, container start latency, resource-limit hits,
validation-failure counts **by reason**, heartbeat age, and concurrency utilisation.

A rise in validation-failure counts is an abuse or a bug signal and pages someone; it is the
metric most worth watching in the whole worker fleet.
