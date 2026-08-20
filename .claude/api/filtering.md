# Filtering and search

> **Status: Designed. Not Implemented.** Phase 3 (search), Phase 5 (finding filters).

## 1. Filter syntax

Query parameters, allowlisted per endpoint. No generic query language — a client-supplied
query DSL is a query-cost injection surface and an index-planning nightmare.

```
GET /api/v1/findings
      ?status=OPEN,CONFIRMED           # comma = OR within a field
      &severity=CRITICAL,HIGH
      &projectId=prj_01J...            # AND across fields
      &assigneeId=usr_01J...
      &lastSeenAt[gte]=2026-08-01T00:00:00Z
      &riskScore[gte]=70
      &tag=production&tag=external      # repeated key = AND for tags
      &q=injection                      # free-text
```

Comparison operators on ordered fields: `[eq]`, `[ne]`, `[gt]`, `[gte]`, `[lt]`, `[lte]`.
Null checks: `assigneeId[isNull]=true`. Negation: `status[not]=FALSE_POSITIVE`.

The tag semantics are deliberately different from enums — filtering by two statuses means
"either", filtering by two tags means "both", because that is what people mean in each case.
It is documented prominently rather than left to be discovered.

## 2. Rules

Every filterable field is allowlisted and backed by an index that leads with
`organizationId`. An unlisted field returns 400 naming what is permitted rather than being
ignored — silently dropping a filter returns more data than the caller asked for, which in
this product could mean showing findings they meant to exclude.

Filter values are validated against their field type before reaching the database. Enum
filters validate against the enum. No filter value is ever interpolated into SQL.

## 3. Free-text search

`q` performs full-text search scoped to the endpoint's resource. Backed by a generated
`tsvector` column with a GIN index, not `ILIKE '%…%'` — leading-wildcard `LIKE` cannot use an
index and degrades linearly with tenant size.

```sql
WHERE organizationId = $1 AND searchVector @@ websearch_to_tsquery('english', $2)
ORDER BY ts_rank(searchVector, websearch_to_tsquery('english', $2)) DESC, id DESC
```

`websearch_to_tsquery` is used rather than `to_tsquery` because it accepts what users actually
type — quoted phrases, `or`, `-exclusion` — without throwing a syntax error on unbalanced
input.

Weighted by field: title (A), description (B), remediation and location (C), evidence text
(D). A match in the title ranks above a match buried in a captured response body.

## 4. Global search

`GET /api/v1/search?q=…&types=finding,asset,project,scan,engagement,report` runs a bounded
per-type query and returns grouped results with a small cap per type — the command menu needs
breadth and speed, not depth. Each type's query applies its own tenant scoping and permission
filter, so a `GUEST` sees results only from projects granted to them.

**The tenant predicate is inside every query, never a post-filter on results.** Post-filtering
means the database returned another tenant's rows to our process, and it means result counts
and ranking were computed across tenants.

## 5. Reference search

CVE, CWE, and OWASP catalogues are global reference data, not tenant-owned, and are searched
without a tenant predicate. They are read-only and contain nothing customer-specific. This is
the only exception to the tenant-scoping rule, and it is explicit here so that it is a decision
rather than an oversight.

## 6. Saved views

A named filter set stored per user, optionally shared with the organisation. Stored as a
validated filter object, not as a raw query string, so a saved view cannot smuggle an
unlisted filter and cannot break when the query format changes.

## 7. Performance

Every filter combination that the UI can produce is covered by an index; a test asserts that
the common combinations do not sequential-scan by checking `EXPLAIN` output in integration
tests. Slow queries are logged with their parameters. Free-text search is rate limited more
tightly than ordinary reads, since it is the most expensive read in the product.

## 8. Testing

Allowlist enforcement, operator correctness, tag AND vs enum OR semantics, filters combining
correctly, cross-tenant leakage under every filter and under free-text search, permission
filtering for project-restricted principals, index usage on common combinations, and injection
attempts through filter values.
