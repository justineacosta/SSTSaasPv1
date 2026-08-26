# Pagination

> **Status: Partially Implemented.** §1's response envelope and §4's default of 50, maximum of
> 100 and clamp-rather-than-reject rule exist as Zod schemas in `@sentinel/contracts`
> (`paginationSchema`, `listQuerySchema`, `collectionEnvelopeSchema`) as of Phase 2 Task 2.
> **No endpoint consumes them yet** — there is no list endpoint in the API. Everything else here
> — the keyset SQL, offset pagination, the cursor encoding, sorting, estimates — is Designed,
> Not Implemented.

**Every list endpoint paginates. There are no unbounded list endpoints.** A tenant with
400,000 findings must not be able to ask for all of them, and an endpoint that works fine in
development against 20 rows is exactly how that ships.

## 1. Cursor pagination (default)

```
GET /api/v1/findings?limit=50&cursor=FIXTURE-not-a-real-cursor-0000000000000000000000000000000
```

```jsonc
{ "data": [ ... ],
  "pagination": { "nextCursor": "eyJz...", "hasMore": true, "limit": 50 } }
```

The cursor is an opaque base64 encoding of the sort key and the tie-breaking ID. Clients must
treat it as opaque; the encoding is not part of the contract and will change.

Underneath, it is keyset pagination:

```sql
WHERE organizationId = $1
  AND (lastSeenAt, id) < ($cursorTime, $cursorId)
ORDER BY lastSeenAt DESC, id DESC
LIMIT 51            -- one extra row determines hasMore without a second query
```

The ID tie-breaker is not optional. Sorting on a non-unique column without it silently skips
or repeats rows whenever two records share a value — which, for timestamps written in the same
transaction, is common rather than rare.

Cursor pagination is the default because its cost is constant regardless of depth, and because
it is stable under concurrent inserts: new findings arriving mid-pagination do not shift rows
into or out of pages the client has already seen.

## 2. Offset pagination (limited)

Only where a jump-to-page control is genuinely needed — audit logs, invoices:

```
GET /api/v1/audit-logs?page=3&perPage=50
```

```jsonc
{ "data": [ ... ],
  "pagination": { "page": 3, "perPage": 50, "totalPages": 26, "totalItems": 1284 } }
```

Offset is capped at 10,000 rows; beyond that the API returns 400 and directs the client to
narrow its filters. Deep offsets force Postgres to scan and discard everything before the
offset, and a `page=100000` request is either a mistake or an attack.

## 3. Counts

Exact counts are expensive at scale, so they are opt-in: `?includeTotal=true` adds
`meta.total`, and clients that only need "is there more" use `hasMore`, which costs nothing.

Above a threshold (100,000 rows matching), the API returns an estimate from
`pg_class.reltuples` adjusted by the filter selectivity, flagged as
`"totalIsEstimate": true`. The UI then renders "about 340,000" rather than a precise number
that cost two seconds to compute and that nobody needed to be exact.

## 4. Limits

Default 50, maximum 100 for most endpoints; maximum 25 for expensive ones (findings with
expanded evidence, scans with logs). A `limit` above the maximum is clamped, not rejected, and
the applied limit is echoed in `pagination.limit`.

## 5. Sorting

`?sort=lastSeenAt:desc,severity:asc` — allowlisted fields only, each backed by an index that
includes the tenant column. An unlisted sort field returns 400 naming the permitted fields.
The sort is always made total by appending `id` as the final key.

Changing the sort invalidates the cursor; the API returns 400 with
`CURSOR_SORT_MISMATCH` rather than silently returning wrong results, because the cursor encodes
the sort it was issued for.

## 6. Client behaviour

TanStack Query's `useInfiniteQuery` with the cursor as the page param. Query keys include the
filters and sort, so changing either starts a fresh sequence. Lists past 100 rows virtualise
([`../ui-ux/tables.md`](../ui-ux/tables.md)).

## 7. Testing

Pagination returns every row exactly once across a full traversal; ties on the sort column do
not skip or duplicate; concurrent inserts during traversal do not corrupt the sequence; the
limit is clamped; an invalid or tampered cursor returns 400 rather than an error or wrong
data; a cursor from tenant A used by tenant B returns nothing rather than tenant A's rows;
deep offsets are rejected.
