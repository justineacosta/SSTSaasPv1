# Scan execution

> **Status: Designed. Not Implemented.** Phase 4.
> Security controls: [`../security/worker-security.md`](../security/worker-security.md).

## 1. States

```
QUEUED ──▶ RUNNING ──┬──▶ COMPLETED
   │          │      ├──▶ FAILED
   │          │      └──▶ TIMED_OUT
   └──────────┴─────────▶ CANCELLED
```

Terminal states are final. A scan is never resumed; a rerun is a new scan that inherits
configuration. This keeps the audit story simple: one scan row, one execution, one scope
version, one answer to "what did we do and when".

## 2. Worker loop

```
1. Reserve job (BullMQ, visibility timeout > engine timeout)
2. Re-validate everything from the database        <- worker-security.md §4
3. Resolve targets: DNS, then deny-list check on every resolved address
4. Transition QUEUED -> RUNNING (compare-and-set; a lost race aborts cleanly)
5. Emit scan.started
6. Start engine container with caps and job on stdin
7. Stream events:
     progress -> update scan.progress, throttled, emit scan.progress
     log      -> append ScanLog (capped, rotated)
     finding  -> normalise -> verify -> dedupe -> persist -> emit scan.finding
     artifact -> upload to storage -> link evidence
     metric   -> record
8. On complete: transition, emit scan.completed, fan out notifications and webhooks
9. Always: destroy container, clean scratch, release the concurrency slot
```

Step 4 uses a compare-and-set on the status so two workers cannot both run one scan. Step 9
runs in a `finally` and is additionally backstopped by a reaper, because "always" in code is
not the same as always.

Findings are persisted **as they stream**, so a scan that dies at 80% retains its findings.
Progress updates are throttled (max 1/second) to avoid drowning the event bus on fast scans.

## 3. Cancellation

A user cancels -> the scan row is marked -> the worker, which polls the row every few
seconds, sends `SIGTERM` to the container, waits 10 seconds, then `SIGKILL`. Partial results
are retained and the scan is `CANCELLED`, clearly distinguished from `COMPLETED`. Latency
target: outbound traffic stops within 15 seconds, because cancellation is sometimes someone
stopping a mistake in progress.

## 4. Retries

Retried (transient): container start failure, worker crash, queue reclaim, DNS resolution
failure. Backoff 30s / 2m / 8m with jitter, three attempts, then dead-letter.

**Never retried:** authorization failure, scope rejection, unverified asset, suspended
organisation, entitlement exhaustion, invalid configuration. Retrying a refusal is exactly
the wrong behaviour — the refusal was the correct answer.

Engine failures are retried once only if the engine reported a transient reason; a crash
mid-scan is not retried automatically, because a rerun may double the traffic sent to a
customer's production system.

## 5. Timeouts and limits

Wall clock is enforced by the worker with an independent timer, not by trusting the engine.
On expiry: `SIGTERM`, then `SIGKILL`, status `TIMED_OUT`, partial results retained, and the
scan is **not** presented as complete. Request budgets and per-host rate limits are enforced
inside the SDK's HTTP client, so an engine cannot exceed them even by mistake.

## 6. Concurrency and fairness

Queues are separated by engine class. Concurrency is capped globally, per worker, and **per
organisation** (from `maxConcurrentScans`). Scans exceeding the org cap stay `QUEUED` and
are shown as queued with position, rather than failing. A weighted-fair scheduler prevents a
single large tenant monopolising workers.

## 7. Health

Workers report heartbeat, active jobs, and resource use to Redis; the API exposes worker
health at `/health/workers` and on the platform admin dashboard. A worker missing heartbeats
has its jobs reclaimed after the visibility timeout. The scheduler sweeps scans stuck in
`RUNNING` beyond timeout plus grace and marks them `FAILED` with a clear reason — a scan
stuck forever is worse than a scan that failed.
