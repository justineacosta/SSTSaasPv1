# API errors

> **Status: Partially Implemented (Phase 1, extended in Phase 2 Tasks 2 and 3).** §1, §2, §5 and §6
> are enforced by `AllExceptionsFilter` and `ZodValidationPipe` in `apps/api`. §3's codes exist in
> `@sentinel/contracts`. §7's "every documented code has at least one test that produces it"
> is **still not** met: most codes have no endpoint that can raise them yet. `UNKNOWN_FIELD`
> stopped being one of them in Phase 2 Task 2 — see §2 — but it is raised by the pipe's unit
> spec, not by any endpoint, because Phase 2 has not shipped one that takes a body.
>
> Task 3 added `PASSWORD_BREACHED` and a `PasswordBreachedError` that returns it at 422, per §2's
> status table in [`conventions.md`](conventions.md) — a valid shape failing a domain rule. It has
> **no producer endpoint** either; Task 8 is where registration first raises it.
>
> **§3's code list and `ERROR_CODES` in `@sentinel/contracts` are independent lists with no parity
> spec between them.** A code added to one and not the other drifts silently, which has already
> happened twice in this phase with other registries. Add to both.

## 1. Envelope

Every error, without exception, returns this shape:

```jsonc
{
  "error": {
    "code": "SCOPE_VIOLATION",
    "message": "Target is not permitted by the project scope.",
    "details": { "target": "admin.example.com", "rule": "No matching allow rule" },
    "requestId": "req_01J8XK2P9V3QWERTY",
    "documentation": "https://docs.sentinel.example/errors/SCOPE_VIOLATION"
  }
}
```

`code` is stable and machine-readable — clients branch on it, never on `message`. `message` is
human-readable, safe to display, and may change. `details` is structured and code-specific.
`requestId` correlates to server logs and is what support will ask for.

## 2. Validation errors

Field errors are returned per field so a client can attach them to inputs:

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "The request contains invalid fields.",
    "details": { "fields": [
      { "path": "name",       "code": "too_short",    "message": "Name must be at least 3 characters." },
      { "path": "targets[0]", "code": "invalid_host", "message": "Enter a valid hostname." }
    ]}, "requestId": "req_..." } }
```

`path` uses dotted/bracketed notation matching the request body, so the client can map errors
without guessing.

**A body whose *only* fault is unknown fields returns `UNKNOWN_FIELD`, not `VALIDATION_ERROR`.**
Every request schema is `.strict()` ([`conventions.md`](conventions.md) §3), so an unrecognised
key is a rejection rather than a silent discard, and it deserves its own code because the client
fix is different — a misspelling, or a field from a newer API version — from a value that failed
a rule. `details.fields` names one entry per offending key, at that key's full path.

The split is deliberately asymmetric: the code is `UNKNOWN_FIELD` only when **every** issue is an
unrecognised key. A body that both misspells a field and fails a real validation rule returns
`VALIDATION_ERROR` and still lists the unrecognised keys in `details.fields`. Branching a mixed
failure to `UNKNOWN_FIELD` would tell a client the spelling was the only problem, and a
validation failure must never hide behind a different code.

**`details.fields` is optional on this code, and a client must treat it that way.**
`VALIDATION_ERROR` is also the fallback for a client-class status the code table does not name —
405, 406, 413, 415 — where there is no field to point at and `details` is absent entirely. A
client that reads `error.details.fields` unconditionally will find `undefined` on a 413. The
alternative, a dedicated code per status, was considered and rejected: see the note on
`codeForStatus` in `apps/api/src/common/filters/all-exceptions.filter.ts`. Revisit in Phase 2,
when there are real endpoints to raise them.

## 3. Codes

**Auth:** `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `MFA_REQUIRED`,
`MFA_INVALID`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_LOCKED`, `INVALID_API_KEY`, `API_KEY_EXPIRED`,
`CSRF_TOKEN_INVALID`.

**Access:** `PERMISSION_DENIED`, `NOT_A_MEMBER`, `ORGANIZATION_SUSPENDED`,
`RESOURCE_NOT_FOUND` (also returned for cross-tenant access).

**Validation:** `VALIDATION_ERROR` (also the fallback for an unmapped client-class status — see
§2), `UNKNOWN_FIELD`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT`, `DUPLICATE_RESOURCE`,
`PASSWORD_BREACHED`.

**Domain — security-testing specific:** `SCOPE_VIOLATION`, `ASSET_NOT_VERIFIED`,
`ASSET_VERIFICATION_EXPIRED`, `TARGET_DENIED_BY_POLICY` (global deny list),
`PROFILE_NOT_PERMITTED`, `ENGINE_NOT_AVAILABLE`, `SCAN_ALREADY_RUNNING`,
`SCAN_NOT_CANCELLABLE`.

**Entitlement:** `QUOTA_EXCEEDED`, `PLAN_LIMIT_REACHED`, `FEATURE_NOT_AVAILABLE`,
`PAYMENT_REQUIRED`, `SUBSCRIPTION_INACTIVE`.

**Rate limit:** `RATE_LIMITED`.

**Server:** `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `DEPENDENCY_UNAVAILABLE`.

## 4. Domain errors carry what the user needs to act

A refusal that does not say how to succeed generates a support ticket. Compare:

```jsonc
// useless
{ "code": "SCOPE_VIOLATION", "message": "Not allowed." }

// useful
{ "code": "SCOPE_VIOLATION",
  "message": "admin.example.com isn't covered by this project's scope.",
  "details": { "target": "admin.example.com", "scopeId": "scp_01J...",
               "reason": "NO_MATCHING_ALLOW_RULE",
               "suggestion": "Add an allow rule for admin.example.com in project scope." } }
```

Quota errors always include the limit, the current usage, and the entitlement key:

```jsonc
{ "code": "QUOTA_EXCEEDED",
  "details": { "entitlement": "maxConcurrentScans", "limit": 3, "current": 3,
               "resetsAt": null, "upgradeUrl": "/billing/plans" } }
```

## 5. What never appears in an error

Stack traces. Database errors, table names, or constraint names. Internal service names, hosts,
or paths. Secrets or credentials, including partially. Whether another tenant's resource
exists. Whether an email address is registered (on login, registration, and reset).

Internal errors return `INTERNAL_ERROR`, a generic message, and the request ID. Everything else
goes to the server log.

Three implementation rules that are easy to get wrong, all covered by tests:

- **Status decides, not exception class.** A framework `HttpException` at 5xx — including
  `new InternalServerErrorException(err.message)`, an ordinary Nest idiom — has its message
  replaced with the generic one. A `DomainError` is the one exception, because its text is
  authored here: `DEPENDENCY_UNAVAILABLE` at 503 exists precisely so `/health/ready` can name
  the dependency that is down. The duty that creates: never build a `DomainError` out of
  driver output.
- **Client-visible text passes through the logger's `redactSecretsInText`,** and `details`
  through its structural `redact()`. Authored 4xx messages quote user input — a rejected
  callback URL, a bad enum value — and a credentialed URL is exactly the shape that arrives
  that way.
- **There are two generic messages, and they must stay two.** When a message is withheld,
  the replacement matches the *class* of the failure: a 5xx gets "Something went wrong on our
  side…", a 4xx gets "The request could not be accepted…". Collapsing them into one string
  tells a caller that their own bad request was the server's fault — which re-introduces, in
  the `message`, exactly the confusion the client-class/server-class split in `code` exists to
  remove (§1, §3), and generates the support ticket §4 is written to avoid. Neither string
  speculates about the cause: a message is withheld precisely because the underlying text is
  not trusted. `apps/api/src/common/filters/all-exceptions.filter.ts` holds both, and its
  spec pins each one against a collapse in either direction.

## 6. Logging

Client errors (4xx) log at `warn` with the code, path, principal, and tenant — not the body,
which may contain credentials. Server errors (5xx) log at `error` with the full stack, request
context, and redacted input, and are reported to Sentry with the request ID as a tag so a
customer's report maps to an exception in one search.

## 7. Testing

The global filter is asserted to produce the envelope for every error class; no endpoint leaks
a raw framework or ORM error; every documented code has at least one test that produces it; a
cross-tenant request produces `RESOURCE_NOT_FOUND` and never `PERMISSION_DENIED`; internal
errors never include a stack in the response body.
