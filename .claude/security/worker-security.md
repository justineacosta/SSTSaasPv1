# Worker and engine isolation

> **Status: Designed. Not Implemented.** Built in Phase 4.
> Decision record: [ADR-0003](../decisions/ADR-0003-worker-isolation.md).

## 1. Two different trust levels

People conflate these. They are not the same thing.

| | **Worker process** | **Engine container** |
|---|---|---|
| What it is | Long-lived BullMQ consumer | Ephemeral process running one scan |
| Trust | Semi-trusted — our code, our infrastructure | **Untrusted** — handles hostile output |
| Database | Narrow credentials, scoped queries | **None** |
| Secrets | Queue + DB + storage credentials | **None** |
| Network | Internal services | Target only, via egress policy |
| Lifetime | Persistent | Destroyed after every job, always |

The worker orchestrates; the engine touches the target. A compromised engine must not be
able to reach anything the worker can.

## 2. Container hardening

Every engine container runs with:

- `--user` non-root, no `setuid` binaries in the image
- `--read-only` root filesystem, with a single small `tmpfs` for scratch
- `--cap-drop=ALL` (nothing added back)
- `--security-opt no-new-privileges`
- seccomp and AppArmor profiles
- `--pids-limit`, `--memory`, `--memory-swap` equal to memory (no swap), `--cpus`
- No host mounts, no Docker socket, no host network, no host PID/IPC namespace
- Hard wall-clock timeout enforced by the worker, which kills and reaps regardless
- Removed after exit, always, including on worker crash — a reaper sweeps orphans

**The Docker socket is never exposed to a worker.** Workers request container execution
through a narrow execution service; handing a worker the socket would make a worker
compromise equivalent to host root.

## 3. Egress policy

Engine containers sit on a dedicated network that:

- **cannot reach** the database, Redis, object storage, the API, the internal subnet, or
  cloud metadata endpoints;
- **can reach** the public internet, subject to the guarded HTTP client and the global
  deny list ([`scope-controls.md`](scope-controls.md)).

This is enforced at the network layer as well as in code, because the code will eventually
have a bug. In production, engine workloads run in an isolated subnet with an egress
gateway and explicit deny rules for internal ranges.

## 4. Job validation before execution

A worker never trusts its payload. The payload carries a `scanId` and `organizationId`;
everything else is re-read from the database:

```
1. Load scan by id.  Missing -> fail, alert.
2. Assert payload organizationId matches the loaded scan.  Mismatch -> fail, alert loudly.
3. Assert organisation active and not suspended.
4. Assert subscription in good standing and entitlements permit execution.
5. Assert scan status is QUEUED and not cancelled.
6. Load asset; assert it exists, is not deleted, and ownership is verified.
7. Load the scope version referenced by the scan; re-evaluate every target.
8. Validate engine config against the engine's schema for the pinned version.
9. Only then: mark RUNNING and execute.
```

A mismatch at step 2 means either a bug or an attempt to forge a job. It fails the job and
raises a platform alert; it is never handled quietly.

## 5. Resource limits and fairness

Defaults, overridable per engine and per plan:

| Limit | Default |
|---|---|
| Wall clock | 30 min (passive 10, aggressive 120) |
| Memory | 1 GiB |
| CPU | 1.0 |
| Processes | 256 |
| Output size | 100 MiB raw |
| Evidence artifacts | 500 per scan |
| Requests to a single target host | rate-limited, budget-capped |

Concurrency is capped **per organisation** as well as globally, so one tenant's burst
cannot starve every other tenant's queue. Queues are separated by engine class so a slow
class does not block a fast one.

## 6. Failure handling

- **Retries** only for genuinely transient failures (network, container start). Never for
  validation or authorization failures — retrying an unauthorised scan is exactly wrong.
- Exponential backoff with jitter, capped attempts, then dead-letter.
- Timeout produces `TIMED_OUT`, retains partial results, and reports honestly rather than
  presenting a truncated scan as complete.
- Worker crash mid-job: the job is reclaimed after a visibility timeout and re-validated
  from scratch; scans stuck in `RUNNING` past a threshold are swept by the scheduler.
- **Cancellation** is cooperative and enforced: the scan row is marked, the worker polls
  it, and the container is killed. Cancellation during execution stops traffic promptly.

## 7. Observability

Every job emits structured logs with `scanId`, `organizationId`, `engineId`, `jobId`, and
trace context — never target response bodies, never credentials. Metrics: queue depth and
age, execution duration by engine, success/failure/timeout rates, container start latency,
resource-limit hits, validation-failure counts by reason. A rise in validation failures is
an abuse signal and pages someone.

## 8. Testing requirements

Payload/DB tenant mismatch rejected; cancelled scan not executed; suspended org not
executed; scope narrowed after enqueue refused; unverified asset refused; timeout kills the
container and reports `TIMED_OUT`; container cannot reach the database, Redis, storage, or
metadata endpoints (asserted from inside the container in an integration test); orphaned
containers are reaped; per-org concurrency cap holds under load.
