# Monitoring and observability

> **Status: Designed. Not Implemented.** Logging in Phase 1; metrics and tracing in Phase 4;
> full alerting in Phase 11.

## 1. Three signals, one correlation ID

Logs, metrics, and traces all carry `requestId` and `traceId`. The `requestId` propagates from
the HTTP request into queue payloads and worker logs, so a customer reporting "my scan failed
at 14:32" resolves to a single trace spanning the API call, the job, the worker, and the engine
container. Without that propagation, debugging asynchronous work is guesswork.

## 2. Logging

Structured JSON. Never plain strings.

```jsonc
{ "level":"info", "time":"2026-08-20T14:30:00.123Z", "service":"api",
  "requestId":"req_01J...", "traceId":"4bf92f...", "organizationId":"org_01J...",
  "userId":"usr_01J...", "msg":"Scan created", "scanId":"scn_01J...", "engineId":"web-security" }
```

Levels: `debug` (development only), `info` (business events), `warn` (client errors, degraded
behaviour, retries), `error` (server errors, failed jobs), `fatal` (crash).

**Redaction is structural, not a regex over the final string.** The serialiser has an allowlist
per known object type and redacts by key name (`password`, `token`, `secret`, `key`,
`authorization`, `cookie`, `apiKey`, `mfaSecret`) plus value-shape heuristics as a backstop.
Never logged: credentials of any kind, session cookies, evidence bodies, scan target response
bodies, or full request bodies on authentication endpoints
([`../security/secrets.md`](../security/secrets.md) §4).

## 3. Metrics

**Product** — organisations, active users, scans started/completed/failed by engine, findings
created by severity, evidence stored, reports generated, retests passed/failed.

**Application** — request rate, error rate, and duration percentiles by route; database query
duration and pool saturation; cache hit rate.

**Queue** — depth and oldest-job age per queue, throughput, failure rate, dead-letter count,
processing duration percentiles.

**Worker** — active jobs, container start latency, execution duration by engine,
resource-limit hits, heartbeat age, concurrency utilisation, and **validation failures by
reason**.

**Security** — failed logins, permission denials, **scope denials**, rate-limit hits, API keys
used after revocation, break-glass accesses.

Two of these deserve special attention. **Scope denial rate** is the primary abuse signal
([`../security/abuse-prevention.md`](../security/abuse-prevention.md) §3): a legitimate customer
occasionally mistypes a host; someone mapping the boundary of what we will scan looks entirely
different. **Worker validation failures by reason** distinguish a benign race (scope narrowed
after enqueue) from something that needs a human.

## 4. Tracing

OpenTelemetry, sampled. Spans cover the request pipeline, database queries, cache operations,
queue enqueue and dequeue, worker execution, engine execution, and outbound HTTP. Errors are
always sampled; successful requests are sampled at a rate.

## 5. Health checks

| Endpoint | Checks | Used by |
|---|---|---|
| `/health/live` | Process responsive | Liveness probe — restarts a wedged process |
| `/health/ready` | Postgres, Redis, storage reachable | Readiness probe — gates traffic and deploys |
| `/health/detailed` | The above plus queue depth, worker heartbeats, migration state | Authenticated, for operators |

Liveness must not check dependencies. A liveness check that fails when Postgres is briefly
unavailable restarts every application instance simultaneously, turning a database blip into a
full outage.

## 6. Alerting

Alert on symptoms customers feel, not on causes. Every alert is actionable and has a runbook
([`runbooks.md`](runbooks.md)); an alert nobody can act on gets deleted or downgraded, because
alert fatigue is what makes the real page get ignored.

**Page immediately:** API error rate > 5% for 5 min; API p99 > 5s for 10 min; database or Redis
unreachable; all workers down; queue oldest-job age > 30 min; **any scan executed against an
unverified or out-of-scope target** (a SEV1 by definition); break-glass access; dead-letter
arrival on a scan queue.

**Notify during hours:** elevated 4xx; single worker down; queue depth trending up; storage
approaching quota; certificate expiring within 14 days; failed-login or scope-denial spike;
webhook endpoint auto-disabled; backup job failed.

## 7. Error tracking

Sentry for both frontend and backend, with `requestId` as a tag so a customer's report maps to
an exception in one search. Source maps uploaded but not served. **PII and secrets are scrubbed
before send** — the Sentry integration uses the same redaction serialiser as the logger, since
an error report containing a request body is a credential leak to a third party.

## 8. Dashboards

Four, each answering one question. **Service health** — is it up and fast? **Queue and
workers** — is work flowing? **Security** — is anything abnormal? **Business** — are customers
getting value? The security dashboard leads with scope denials, failed logins, permission
denials, and break-glass events, because those are the numbers that change the day when they
move.
