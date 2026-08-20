# API errors

> **Status: Designed. Not Implemented.** Phase 1.

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

## 3. Codes

**Auth:** `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `MFA_REQUIRED`,
`MFA_INVALID`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_LOCKED`, `INVALID_API_KEY`, `API_KEY_EXPIRED`,
`CSRF_TOKEN_INVALID`.

**Access:** `PERMISSION_DENIED`, `NOT_A_MEMBER`, `ORGANIZATION_SUSPENDED`,
`RESOURCE_NOT_FOUND` (also returned for cross-tenant access).

**Validation:** `VALIDATION_ERROR`, `UNKNOWN_FIELD`, `INVALID_STATE_TRANSITION`,
`VERSION_CONFLICT`, `DUPLICATE_RESOURCE`.

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
