# Database migrations

> **Status: Designed. Not Implemented.** Phase 1.
> Schema design: [`../architecture/database.md`](../architecture/database.md).

Prisma Migrate. Forward-only. Reviewed like code, because a bad migration is the one class of
bug you cannot fix by deploying again.

## 1. Rules

1. **Forward-only.** No down migrations. Rolling back a schema change in production means
   rolling forward with a corrective migration, because a down migration that drops a column
   destroys the data written since deploy.
2. **Migrations run as a deployment stage**, never on application boot. N application instances
   starting simultaneously would race, and a migration must complete before new code serves
   traffic.
3. **Every destructive change uses expand/contract.** Never rename, drop, or retype in one
   step — see §2.
4. **Review the generated SQL**, always. Prisma's inference is good, not clairvoyant; it will
   happily generate a table rewrite that locks a large table.
5. **Test against production-scale data** for anything touching a large table. A migration that
   takes 200ms on 100 rows can take 40 minutes and hold an `ACCESS EXCLUSIVE` lock on 100
   million.
6. **One logical change per migration**, with a descriptive name.

## 2. Expand/contract

Renaming `Finding.description` to `Finding.summary`, across three releases:

```
Release 1 (expand)   add `summary` nullable; write to both; read from `description`
Release 2 (migrate)  backfill `summary` in batches; switch reads to `summary`; keep writing both
Release 3 (contract) stop writing `description`; drop it
```

Slower, and it is the only approach where a rollback at any point leaves a working system.
The same shape applies to type changes, splitting a column, and moving a relation.

## 3. Locking

Postgres DDL takes locks, and a lock on a hot table is an outage.

| Operation | Lock | Safe? |
|---|---|---|
| `ADD COLUMN` nullable, no default | Brief `ACCESS EXCLUSIVE` | Safe |
| `ADD COLUMN` with a volatile default | Table rewrite | **Unsafe on large tables** |
| `DROP COLUMN` | Brief | Safe, but do it in the contract step |
| `ALTER COLUMN TYPE` | Table rewrite | **Unsafe** — expand/contract instead |
| `CREATE INDEX` | Blocks writes | **Use `CONCURRENTLY`** |
| `ADD CONSTRAINT ... CHECK` | Full scan, blocks writes | Add `NOT VALID`, then `VALIDATE` separately |
| `ADD FOREIGN KEY` | Locks both tables | Add `NOT VALID`, then `VALIDATE` |

Indexes on existing tables are created with `CREATE INDEX CONCURRENTLY`, which Prisma does not
generate — it goes in a hand-written migration, and `CONCURRENTLY` cannot run inside a
transaction, so the migration is marked accordingly.

Every migration sets a `lock_timeout` and a `statement_timeout` so a blocked migration fails
fast rather than queueing every query behind it and taking the site down.

## 4. Backfills

Backfills are **not** migrations. A migration adds the column; a background job fills it, in
batches, with a delay between batches, resumable, and idempotent. A single
`UPDATE finding SET ...` across ten million rows holds one transaction open long enough to
bloat the table and block autovacuum.

## 5. Tenant tables

Every new tenant-owned table requires, in the same change:

- [ ] `organizationId` column with an index leading on it
- [ ] Foreign key to `Organization` with deliberate `ON DELETE` behaviour
- [ ] **Every other** foreign key on the table declares `onDelete` explicitly, and none of
      them is `Cascade` from a parent that is not itself tenant-scoped
- [ ] RLS enabled with the standard policy
- [ ] Registration in the tenant-isolation resource registry
      ([`testing.md`](testing.md) §3) — **CI fails without it**
- [ ] Inclusion in the retention policy if it holds customer data

The registry requirement is the important one: it is what stops isolation coverage rotting as
the schema grows.

Three of those are now mechanical rather than a promise. `pnpm check:registry`
(`scripts/check-tenant-registry.ts`, wired into `.github/workflows/ci.yml`) reads the generated
Prisma DMMF and fails the build when:

- a model carries `organizationId` and is not in `TENANT_OWNED_MODELS`;
- a model *in* `TENANT_OWNED_MODELS` has lost the column, or no longer exists — so the registry
  cannot go stale in either direction;
- a model is accounted for by none, or by more than one, of `TENANT_OWNED_MODELS`,
  `TENANT_ROOT_MODEL` and `DELIBERATELY_GLOBAL_MODELS` (all in
  `packages/db/src/tenant-resources.ts`). The first two rules are keyed on a column, so neither
  can see `Organization` — the tenant root has no `organizationId` because it *is* the tenant.
  Accounting is what covers it;
- a foreign key **into** a tenant-owned table **from a parent that is not itself tenant-scoped**
  is `ON DELETE CASCADE`, or omits `onDelete` altogether. See
  [`../security/tenant-isolation.md`](../security/tenant-isolation.md) §2, Layer 2, for why
  RI cascades are the one class both isolation layers are blind to — and for why the qualifier
  in that sentence is load-bearing rather than pedantic.

The omission case is reported rather than assumed on purpose. Measured against Prisma 6.19.3:
when a relation omits `onDelete`, the DMMF carries no `relationOnDelete` key at all, so there is
no default for the check to evaluate — and the default Prisma would apply differs by whether the
field is optional. One word of schema per foreign key is cheaper than a guess in the one place
where being wrong is invisible to both isolation layers.

## 6. Audit table

`AuditEvent` has `UPDATE` and `DELETE` revoked from the application role by migration, plus a
trigger that raises on either. Any migration touching that table must preserve both
([`../security/audit.md`](../security/audit.md) §2).

## 7. Deployment sequence

```
1. Back up (verified, restorable)
2. Run migrations as a job; wait for success
3. Deploy application code
4. Verify health checks
5. Run backfills as background jobs
```

Because migrations are expand/contract, step 3 can be rolled back to the previous application
version without a schema rollback — the old code still works against the expanded schema. That
property is the entire reason for the discipline.

## 8. Local

```
pnpm db:migrate          # create + apply in dev
pnpm db:migrate:create   # create without applying, to review the SQL
pnpm db:reset            # DESTRUCTIVE, local only
```

Never edit an applied migration. Never delete one. If a migration is wrong, write the next one.
