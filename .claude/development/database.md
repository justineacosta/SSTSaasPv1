# Working with the database

> **Status: Designed. Not Implemented.** Phase 1.
> Schema design: [`../architecture/database.md`](../architecture/database.md).
> Migration policy: [`migrations.md`](migrations.md).

Practical guidance for day-to-day query work. The rules that protect tenants are in
[`../security/tenant-isolation.md`](../security/tenant-isolation.md); this is about writing
queries that are correct and fast.

## 1. Always use the tenant-scoped client

```ts
// wrong — will throw, and correctly so
const findings = await prisma.finding.findMany({ where: { status: 'OPEN' } });

// right
const findings = await ctx.db.finding.findMany({ where: { status: 'OPEN' } });
```

`ctx.db` is bound to the request's organisation. It injects `organizationId` into every read
and write, and rewrites `findUnique` into a tenant-scoped `findFirst` — because
`findUnique({ where: { id } })` would otherwise bypass the filter entirely, which is the single
easiest mistake to make in a multi-tenant Prisma codebase.

## 2. Select what you need

```ts
// wrong — fetches every column of every relation
const finding = await ctx.db.finding.findFirst({ where: { id }, include: { evidence: true } });

// right
const finding = await ctx.db.finding.findFirst({
  where: { id },
  select: {
    id: true, title: true, severity: true, status: true,
    asset: { select: { id: true, name: true } },
    _count: { select: { occurrences: true } },
  },
});
```

Explicit `select` also means adding a column to the schema does not silently start shipping it
through every API response.

## 3. Avoiding N+1

The failure mode: a list query followed by a per-row query inside a loop. With 50 findings that
is 51 round trips.

```ts
// wrong
for (const f of findings) { f.asset = await ctx.db.asset.findFirst({ where: { id: f.assetId } }); }

// right — one query
const findings = await ctx.db.finding.findMany({
  where: { status: 'OPEN' },
  select: { id: true, title: true, asset: { select: { id: true, name: true } } },
});
```

Hot paths assert their query count in integration tests, so an N+1 introduced later fails CI
rather than being discovered by a customer with 400,000 findings.

## 4. Transactions

Anything writing more than one row runs in a transaction, with its audit event inside:

```ts
await ctx.db.$transaction(async (tx) => {
  const scan = await tx.scan.create({ data: { ... } });
  await tx.scanTarget.createMany({ data: targets.map(t => ({ scanId: scan.id, ...t })) });
  await tx.auditEvent.create({ data: { action: 'SCAN_CREATED', resourceId: scan.id, ... } });
  return scan;
});
// side effects AFTER commit — enqueue, email, webhook, realtime
```

**Never enqueue a job inside a transaction.** If the transaction rolls back, the worker
processes something that does not exist. Keep transactions short: no HTTP calls, no queue
operations, no file uploads inside one.

## 5. Concurrency

`Finding` and `Scope` carry a `version`. Update with the version in the `where` clause and
treat a zero-row result as a conflict:

```ts
const updated = await ctx.db.finding.updateMany({
  where: { id, version: expectedVersion },
  data: { status, version: { increment: 1 } },
});
if (updated.count === 0) throw new VersionConflictError();
```

Without this, two people triaging the same finding silently overwrite each other, and the
loser never knows.

## 6. Raw SQL

Permitted where Prisma cannot express an efficient query — dashboard aggregates, full-text
search ranking, window functions. Rules:

- **Always parameterised** (`Prisma.sql` tagged templates). Never string concatenation.
- **Always includes the tenant predicate explicitly**, since the client extension cannot
  rewrite raw SQL. RLS is the backstop, not the plan.
- Reviewed by a second person and commented with why Prisma was insufficient.
- Covered by an integration test including a cross-tenant assertion.

## 7. Performance checks

Use `EXPLAIN (ANALYZE, BUFFERS)` on any new query against realistic data volumes. Watch for
sequential scans on large tables, sorts that spill to disk, and nested loops over big row
counts. Integration tests assert index usage for the filter combinations the UI can produce
([`../api/filtering.md`](../api/filtering.md) §7).

Slow queries log with their parameters (redacted) above a threshold. A query that is fast on a
developer's 200-row database and slow on a customer's 2-million-row database is the normal
case, not the exception — which is why the seed data for performance testing is generated at
scale rather than sampled from development.
