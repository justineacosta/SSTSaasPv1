# API conventions

> **Status: Designed. Not Implemented.** Phase 1 onward.

REST over HTTPS, JSON only, versioned at `/api/v1`.

## 1. URLs

Plural nouns, kebab-case, hierarchical only where the child cannot exist without the parent:

```
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{projectId}
PATCH  /api/v1/projects/{projectId}
DELETE /api/v1/projects/{projectId}

GET    /api/v1/projects/{projectId}/assets     # assets belong to a project
GET    /api/v1/findings?projectId=...          # findings are queried globally, filtered
POST   /api/v1/scans/{scanId}/cancel           # an action, not a resource
```

Findings and scans are addressed globally with filters rather than nested, because the primary
views are cross-project. Nesting them would make the most common query the awkward one.

Actions that are not CRUD get a verb sub-resource (`/cancel`, `/verify`, `/rotate`,
`/test`, `/retry`). Resource IDs are opaque prefixed strings (`fnd_01J…`); clients must not
parse them.

**The organisation is never in the URL.** It comes from the authenticated session or API key
context. Putting a tenant ID in a path invites people to change it, and invites us to trust
it.

## 2. Methods and status codes

`GET` read, `POST` create or action, `PATCH` partial update, `PUT` full replace (rare),
`DELETE` remove. `PATCH` is the default for updates; whole-object `PUT` loses concurrent edits.

| Code | Meaning here |
|---|---|
| 200 | Success with body |
| 201 | Created, with `Location` |
| 202 | Accepted — queued (scans, reports, exports) |
| 204 | Success, no body |
| 400 | Malformed request |
| 401 | No or invalid credentials |
| 403 | Authenticated, lacks the permission **within their own organisation** |
| 404 | Not found **or in another tenant** — deliberately indistinguishable |
| 409 | Conflict: duplicate, or version mismatch |
| 402 | Entitlement or quota exhausted |
| 422 | Valid shape, failed a domain rule (e.g. invalid status transition) |
| 429 | Rate limited, with `Retry-After` |
| 5xx | Ours; returns a request ID and nothing else |

The 403/404 distinction is a security decision, explained in
[`../security/authorization.md`](../security/authorization.md) §6.

## 3. Requests

`Content-Type: application/json`, UTF-8. Field names `camelCase`. Timestamps ISO 8601 with
offset, always UTC (`2026-08-20T14:30:00Z`). Durations in seconds, sizes in bytes, money in
minor units with a currency code. Enums are `SCREAMING_SNAKE_CASE` strings, never integers —
an integer enum in an API is a future migration.

Unknown fields in a request body are **rejected**, not ignored. Silently discarding a
misspelled field is how a client ships a bug that looks like a server bug.

## 4. Responses

Single resource returns the object at the top level. Collections use a consistent envelope
([`pagination.md`](pagination.md)):

```jsonc
{ "data": [ ... ], "pagination": { "nextCursor": "...", "hasMore": true, "limit": 50 },
  "meta": { "total": 1284 } }
```

`limit` is the limit the server **applied**, not the one the client asked for. A request over the
maximum is clamped rather than rejected ([`pagination.md`](pagination.md) §4), and without the echo
a client that asked for 500 and received 100 has no way to tell a clamp from a short page. This
example omitted `limit` until Phase 2 Task 2, when `paginationSchema` in `@sentinel/contracts`
gained it — the two documents disagreed and this one was the stale half.

Responses come from explicit DTOs, never raw Prisma models — a relation accidentally included
cannot leak. Nulls are explicit; a field that exists is always present, even when null. Absent
means "not applicable to this resource type", which is a different statement from null.

Field selection via `?fields=` and relation expansion via `?expand=` on endpoints that support
it, both allowlisted. `expand` is bounded — no arbitrary depth, because arbitrary depth is an
arbitrary query cost.

## 5. Idempotency

`POST` endpoints that create billable or side-effecting resources (scans, reports, invitations)
accept `Idempotency-Key`. The key, request hash, and response are stored for 24h; a repeat with
the same key returns the original response, and a repeat with the same key but a different body
returns 409.

## 6. Concurrency

Resources with contended edits (`Finding`, `Scope`) carry a `version`. `PATCH` may include
`If-Match` with the version; a mismatch returns 409 with the current state, so the client can
show a real conflict rather than silently overwriting a colleague's triage.

## 7. Headers

Request: `Authorization`, `Idempotency-Key`, `X-Request-Id` (echoed, generated if absent),
`X-CSRF-Token` (cookie auth, unsafe methods).
Response: `X-Request-Id`, `RateLimit-*`, `Retry-After`, `Location`, `Deprecation` and `Sunset`
on deprecated endpoints.

## 8. Versioning

`/api/v1` is a contract. Additive changes — new endpoints, new optional fields, new enum values
clients are told to tolerate — ship in place. Removing a field, renaming, changing a type,
tightening validation, or changing a status code requires `/api/v2` and a documented migration
with a minimum 6-month overlap and `Deprecation`/`Sunset` headers throughout.

The OpenAPI schema is generated from the Zod contracts, committed, and **diffed in CI**, so an
accidental breaking change is caught in review rather than by a customer's pipeline. The diff is
`pnpm check:openapi` (`scripts/check-openapi-diff.ts`), a required step in
`.github/workflows/ci.yml`: it regenerates the document to a scratch path, compares it to the
committed `apps/api/openapi.json`, and prints the differing JSON paths. A difference that
*removes* or *changes* something is called out as breaking, because that is the case this
section says needs `/api/v2`.
