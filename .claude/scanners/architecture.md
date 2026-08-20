# Scanner architecture

> **Status: Designed. Not Implemented.** Phase 4–5.

## 1. Layers

```
Scan request        -> validation, scope, entitlements        (api)
Job                 -> queue, retry, priority                 (bullmq)
Orchestration       -> re-validation, container lifecycle      (worker)
Engine              -> the actual testing                      (engine container)
Normalisation       -> raw -> canonical Finding                (worker)
Verification        -> confirm, downgrade, or drop             (worker)
Deduplication       -> fingerprint, upsert, occurrence         (worker)
Evidence            -> store artifacts, link metadata          (worker + storage)
Risk                -> severity, CVSS, context, SLA            (worker)
Persistence         -> transactional write                     (postgres)
Events              -> realtime, notifications, webhooks       (redis -> api -> client)
```

Only the **Engine** layer is engine-specific. Everything above and below it is shared,
which is what keeps adding a twelfth engine cheap.

## 2. Engine catalogue

| Engine | Category | Phase | Status |
|---|---|---|---|
| `web-security` | WEB | 5 | Not Implemented |
| `api-security` | API | 6 | Not Implemented |
| `tls-config` | WEB | 5 | Not Implemented |
| `sast` | SAST | 12 | Not Implemented |
| `dependency` | DEPENDENCY | 12 | Not Implemented |
| `container` | CONTAINER | 12 | Not Implemented |
| `cloud-config` | CLOUD | 12 | Not Implemented |
| `network` | NETWORK | 12 | Not Implemented |
| `mobile` | MOBILE | 12 | Not Implemented |
| `llm-security` | LLM | 12 | Not Implemented |
| `performance` | PERFORMANCE | 12 | Not Implemented |
| `accessibility` | ACCESSIBILITY | 12 | Not Implemented |

## 3. Web security engine — planned checks

Phase 5 scope. Every check is **non-destructive** at `SAFE`, the default profile.

**Passive (no attack traffic):** security headers (HSTS, CSP, `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`); cookie attributes (`Secure`,
`HttpOnly`, `SameSite`, prefixes, scope); TLS (protocol versions, cipher suites, certificate
validity, chain, key strength, OCSP); CORS misconfiguration (wildcard with credentials,
origin reflection, null origin); information disclosure (server banners, framework version
headers, stack traces, `.git`/`.env`/backup files, source maps, directory listing);
technology fingerprinting; mixed content; cache-control on sensitive responses.

**Active but safe:** open redirect (marker-based, no external callback); path traversal
(read-only probes for known-safe files); reflected XSS (unique marker reflection with
context analysis — detection, not execution); SQL injection (boolean and time-based
inference only, never `UNION` dumping or writes); command injection (time-based inference);
SSRF (marker request to our own controlled collector, never to a third party); CSRF (token
presence and validation behaviour on state-changing endpoints); session handling (fixation,
rotation on login, timeout, invalidation on logout); authentication behaviour (user
enumeration, lockout presence, password policy); rate-limit presence; file upload validation
(type and content enforcement, without uploading anything executable); HTTP method
permissiveness; host-header injection.

**Never at any profile below `AGGRESSIVE`, and never without explicit opt-in:** anything
that writes, deletes, or changes target state; brute forcing; resource exhaustion; payloads
intended to execute rather than to prove reachability.

## 4. Scan profiles

| Profile | Traffic | Duration | Use |
|---|---|---|---|
| `PASSIVE` | Observation only, no attack payloads | Minutes | Continuous, production-safe |
| `SAFE` (default) | Non-destructive active checks, conservative rates | ~30 min | Default for everything |
| `STANDARD` | Broader coverage, deeper crawl | ~2 h | Scheduled deep scans |
| `AGGRESSIVE` | Potentially disruptive; explicit opt-in and elevated permission | Hours | Authorised pentest windows only |

Profile availability is an entitlement and a permission, and is re-checked in the worker.

## 5. Progress and partial results

Findings are persisted **as they arrive**, not batched at the end. A scan that fails at 80%
keeps the findings from the first 80% and is honestly marked `FAILED` with partial results —
never presented as a complete clean scan. Progress percentages come from the engine's phase
model, and an engine that cannot estimate reports phases rather than fabricating a
percentage. **A progress bar that is not driven by real engine events must not exist.**

## 6. Extensibility

Adding an engine touches: the engine implementation, its descriptor, a registry entry, and
its tests. It does not touch the queue, the worker orchestrator, normalisation,
deduplication, evidence, risk scoring, the API, or the UI. If adding an engine requires
changing any of those, the contract has leaked and that is a defect to fix in the contract
rather than to work around. See [`adding-engines.md`](adding-engines.md).
