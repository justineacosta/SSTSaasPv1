# Realtime architecture

> **Status: Designed. Not Implemented.** Phase 4.

**Server-Sent Events**, not WebSockets. The traffic is essentially one-directional
(server → client), SSE runs over plain HTTP so it inherits our authentication, CSRF posture,
proxies, and Cloudflare handling unchanged, and it reconnects automatically. WebSockets would
add a second authentication and authorization surface — historically a rich source of
tenant-isolation bugs — to buy a channel we do not need. Client → server actions go through
the normal REST API.

## 1. Flow

```
worker ──publish──▶ Redis channel  org:{organizationId}
                          │
                    (every api instance subscribes)
                          ▼
                    api SSE endpoint  ── filter by tenant + permission ──▶ browser
```

No sticky sessions: any API instance can serve any client because the fan-out is through
Redis rather than in-process memory.

## 2. Endpoint

`GET /api/v1/events` — authenticated by session cookie, scoped to the active organisation at
handshake, optionally narrowed by `?scanId=` or `?projectId=`.

Authorization is applied **per event, at send time**, not only at connection time:

- the event's `organizationId` must equal the connection's;
- the connection's principal must hold the permission the event type requires
  (`scan.*` → `scan.read`, `finding.*` → `finding.read`);
- project-restricted principals (`GUEST`) receive only events for granted projects.

Permission changes mid-connection are honoured, because the check is re-evaluated rather than
cached from the handshake — a demoted user stops receiving events they may no longer see.

## 3. Events

```
scan.started   scan.progress   scan.finding   scan.completed   scan.failed   scan.cancelled
finding.created   finding.updated   finding.reopened
report.generated   report.failed
notification.created
retest.completed
usage.limit_approaching
```

Payloads are **thin**: identifiers, a status, and enough for a summary line. They never carry
finding bodies or evidence. The client uses the event to invalidate the relevant TanStack
Query keys and refetch through the normal authorised endpoints, which means the realtime
channel can never become a second, less-guarded way to read data.

```
event: scan.progress
id: 01J...
data: {"scanId":"scn_01J...","percent":42,"phase":"tls","findingsSoFar":3}
```

## 4. Reliability

Heartbeat comment every 20 s to keep proxies from idling the connection out. Client
reconnects with exponential backoff and jitter, resuming from `Last-Event-ID` where the
server can replay from a short Redis buffer (60 s); beyond that it refetches state outright.
`scan.progress` is throttled server-side to at most 1/second per scan.

**The UI never simulates progress.** If the stream is disconnected, the interface says so and
falls back to polling. A progress bar that advances without server events is a lie about
system state, and in a security product that is unacceptable.

## 5. Scale

One Redis subscription per API instance per organisation channel, not per client. Connections
are capped per user and per organisation. Long-lived connections are counted in metrics
(active connections, events published, events delivered, dropped-by-permission, reconnection
rate) because connection leaks are the usual failure mode here.
