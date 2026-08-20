# Engine contract

> **Status: Designed. Not Implemented.** Phase 4 (contract + runner), Phase 5 (first
> engine). Decision record: [ADR-0010](../decisions/ADR-0010-engine-contract.md).

Every testing engine — web, API, SAST, dependency, container, cloud, network, mobile, LLM,
performance, accessibility — implements this one contract. The platform knows nothing about
any specific engine beyond it.

## 1. Why the contract is data, not an interface

The contract is a **JSON protocol over stdio**, not a TypeScript interface. An engine is any
executable that reads a job on stdin and writes newline-delimited JSON events on stdout.

This is what makes engines language-agnostic. A TypeScript engine imports
`packages/engine-sdk`; a Python engine imports `workers/python-sdk`; a future Go engine
implements the protocol directly. None of them are coupled to the platform, and none can
reach into it — which matters because engines run untrusted.

## 2. Descriptor

Every engine publishes a static descriptor, registered at build time and stored in the
`Engine` table:

```jsonc
{
  "id": "web-security",
  "name": "Web Application Security",
  "version": "1.4.0",              // semver; scans pin the version they ran
  "category": "WEB",               // WEB|API|SAST|DEPENDENCY|CONTAINER|CLOUD|NETWORK|MOBILE|LLM|PERFORMANCE|ACCESSIBILITY
  "runtime": "node",               // node|python|go|container
  "capabilities": ["security-headers", "tls", "cookies", "cors", "info-disclosure"],
  "supportedAssetTypes": ["URL", "DOMAIN", "SUBDOMAIN", "APPLICATION"],
  "supportedProfiles": ["PASSIVE", "SAFE", "STANDARD"],
  "requiresNetworkEgress": true,
  "defaultTimeoutSeconds": 1800,
  "resourceHints": { "memoryMb": 1024, "cpus": 1.0 },
  "configurationSchema": { /* JSON Schema, validated at scan creation */ }
}
```

`configurationSchema` is enforced at scan creation **and** re-validated in the worker
against the pinned version, so a config valid for 1.4.0 cannot be silently reinterpreted by
1.5.0.

## 3. Job input

Written to the engine's stdin once, then the stream closes:

```jsonc
{
  "jobId": "job_01J...",
  "scanId": "scn_01J...",
  "engineVersion": "1.4.0",
  "profile": "SAFE",
  "targets": [
    { "id": "tgt_1", "type": "URL", "value": "https://app.example.com",
      "resolvedAddresses": ["93.184.216.34"] }
  ],
  "config": { "followRedirects": true, "maxDepth": 3 },
  "constraints": {
    "timeoutSeconds": 1800,
    "maxRequests": 5000,
    "requestsPerSecondPerHost": 5,
    "maxEvidenceBytes": 104857600
  },
  "credentials": null   // present only for authenticated scans, ephemeral, never logged
}
```

The job contains **no** database URL, no queue credentials, no storage credentials, and no
tenant identifiers beyond what the engine needs. An engine cannot learn which customer it is
working for, which is deliberate: a compromised engine should not be able to say whose
infrastructure it just mapped.

Targets arrive **pre-resolved and pre-authorised**. The engine does not decide what to scan;
it scans exactly what it is given. Scope enforcement happens before this point, in the
worker ([`../security/scope-controls.md`](../security/scope-controls.md)).

## 4. Output events

Newline-delimited JSON on stdout. Anything on stderr is captured as diagnostic log only.

```jsonc
{"type":"progress","percent":35,"phase":"tls","message":"Analysing TLS configuration"}
{"type":"log","level":"info","message":"Discovered 14 endpoints"}
{"type":"finding", "finding": { /* see §5 */ }}
{"type":"artifact","artifactId":"art_1","contentType":"image/png","path":"/tmp/out/a.png","label":"Screenshot"}
{"type":"metric","name":"requestsSent","value":432}
{"type":"complete","status":"SUCCESS","summary":{"findingsEmitted":7,"requestsSent":432}}
```

`complete` is mandatory. An engine that exits without it is treated as `FAILED`, never as
"succeeded with no findings" — silence must never be mistaken for a clean result.

## 5. Raw finding shape

Engines emit *candidate* findings. They do not assign final severity, risk, or identity —
normalisation and risk scoring are platform concerns, so that two engines reporting the same
issue produce comparable output.

```jsonc
{
  "checkId": "missing-hsts",
  "title": "Strict-Transport-Security header not set",
  "description": "The response did not include an HSTS header...",
  "targetId": "tgt_1",
  "location": { "url": "https://app.example.com/", "method": "GET",
                "parameter": null, "line": null },
  "severityHint": "MEDIUM",
  "confidence": "HIGH",          // HIGH | MEDIUM | LOW — drives verification and triage
  "cwe": 319,
  "owasp": "A05:2021",
  "cvssVector": "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N",
  "evidence": [
    { "type": "HTTP_REQUEST",  "inline": "GET / HTTP/1.1\nHost: app.example.com" },
    { "type": "HTTP_RESPONSE", "inline": "HTTP/1.1 200 OK\n..." }
  ],
  "remediation": "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "references": ["https://owasp.org/..."],
  "fingerprintInputs": { "check": "missing-hsts", "host": "app.example.com", "path": "/" },
  "verification": { "method": "HEADER_ABSENT", "reproducible": true }
}
```

`fingerprintInputs` is the engine's contribution to deduplication: the fields that identify
*this vulnerability* as distinct from another instance of the same check. Choosing them well
is the hardest part of writing an engine — see
[`finding-deduplication.md`](finding-deduplication.md).

`confidence` must be honest. `HIGH` means the engine proved it. `LOW` means it inferred it.
Marking everything `HIGH` destroys the triage queue, which is the thing the customer
actually uses.

## 6. Lifecycle

```
descriptor()   registration only, never at scan time
execute(job)   stdin -> event stream on stdout
cancel()       SIGTERM -> 10s grace -> SIGKILL; engine must stop traffic promptly
healthCheck()  used by the worker before dispatch and by readiness probes
```

Cancellation is a hard requirement, not a courtesy: a user pressing "cancel" must stop
outbound traffic quickly, because it may be stopping an accident.

## 7. Rules every engine must obey

1. **Only contact given targets.** No target discovery outside the provided list unless the
   descriptor declares that capability and the platform pre-authorises the expansion.
2. **All HTTP goes through the SDK's guarded client.** Never a raw socket or bare fetch —
   the guard is where SSRF and deny-list protection live.
3. **Respect `constraints`.** Rate limits, request budget, and timeout are contractual.
4. **Non-destructive unless the profile is `AGGRESSIVE`.** Detect, do not exploit. No
   writes, no deletes, no state change on the target.
5. **Never log credentials or full response bodies** to stderr.
6. **Deterministic fingerprint inputs.** The same vulnerability must produce the same inputs
   across runs, and must not include volatile values (timestamps, nonces, session IDs).
7. **Exit non-zero on failure**, and emit `complete` with `status: "FAILED"` and a reason.
8. **No filesystem writes outside the scratch directory**; no network to anything but
   targets.

## 8. Testing an engine

Every engine ships with: unit tests per check against recorded fixtures; integration tests
against a deliberately vulnerable target in the local compose stack; a **false-positive
suite** run against a known-clean target that must produce zero findings; fingerprint
stability tests across runs; constraint-compliance tests (timeout honoured, rate limit
respected, cancellation prompt); and a schema conformance test asserting every emitted event
validates against the contract.

The false-positive suite is not optional. An engine that cries wolf is worse than no engine.
