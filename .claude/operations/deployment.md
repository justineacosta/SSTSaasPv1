# Deployment

> **Status: Designed. Not Implemented.** CI in Phase 1; production deployment and IaC in
> Phase 11. Terraform is not installed on the current host.

## 1. Pipeline

```
push / PR
  install -> lint -> typecheck -> unit -> integration -> security suites -> build
          -> e2e -> container scan -> [main only] deploy staging -> smoke
          -> manual approval -> deploy production
```

Every stage is a gate. **Production deployment is impossible without a fully green pipeline
and an explicit human approval.** The security suites — tenant isolation and the authorization
matrix — are gates like any other, not an advisory nightly job.

## 2. Build artifacts

Each app builds to a container image, tagged with the commit SHA (never `latest` in
production — `latest` makes it impossible to say what is running). Base images are pinned by
digest and rebuilt weekly to pick up OS patches. Images run as non-root with a read-only root
filesystem where the app allows it.

Images are scanned for vulnerabilities before deploy; a critical finding in our own image
blocks the deploy. Building a security product on a vulnerable base image would be difficult to
explain.

## 3. Deployment order

### Step 0, once per database, before any migration ever runs

**The migration history is not self-contained.** Two roles and the database name are
out-of-band preconditions, and the first migration that needs one is Phase 1's — so there is no
point at which a migration could have created it. Measured against a bare `postgres:16-alpine`:
`prisma migrate deploy` fails at `20260820121229_row_level_security` with
`role "sentinel_app" does not exist` (42704), and with the init script mounted the whole history
replays and exits 0 (carry-forward ruling 96).

A platform operator runs these **as a superuser**, once, against a database named `sentinel`:

```sql
-- The role the API process connects as. Not a superuser and NOT BYPASSRLS: that is the
-- only thing that makes row-level security a real second layer rather than decoration.
CREATE ROLE sentinel_app LOGIN PASSWORD '<from the secret manager>';
GRANT CONNECT ON DATABASE sentinel TO sentinel_app;
GRANT USAGE ON SCHEMA public TO sentinel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sentinel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sentinel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sentinel_app;

-- ADR-0020. Owns user_organizations(text) and nothing else. BYPASSRLS requires superuser
-- to grant, which is why a migration cannot create this role for itself.
CREATE ROLE sentinel_org_lookup NOLOGIN NOINHERIT BYPASSRLS;
```

`infra/docker/postgres/init/01-app-role.sql` is the same statements, and is the authority — it is
mounted as a Postgres init script locally and in Testcontainers, so it is exercised on every
integration run. **It hard-codes `GRANT CONNECT ON DATABASE sentinel`**, so mounting it against a
database with any other name fails with `database "sentinel" does not exist`. The database name
is a precondition, not a preference.

Two things go wrong if this step is skipped or done partially, and they fail differently.
Without `sentinel_app` the migration history stops on its second migration, loudly. Without
`sentinel_org_lookup` the Task 13 migration raises a named `undefined_object` telling the
operator which role to create — deliberately, rather than failing at `ALTER FUNCTION ... OWNER
TO` with a message about a role nobody has heard of.

**Do not grant `BYPASSRLS` to `sentinel_app` to make something work.** It is the attribute the
whole of `security/tenant-isolation.md` §2 rests on, and
`packages/db/src/migration.integration.spec.ts` asserts its absence.

### Then, on every deploy

Order matters, and getting it wrong causes an outage that looks like a code bug:

```
1. Run migrations as a one-shot job. Wait for success. Abort everything on failure.
2. Deploy API — rolling, health-gated, one instance at a time.
3. Deploy workers — drain in-flight jobs, then replace.
4. Deploy web.
5. Verify health checks and smoke tests.
6. Start backfill jobs, if any.
```

Migrations run **before** code because they are expand/contract and therefore backward
compatible with the currently-running version. Workers drain rather than being killed, so
in-flight scans finish or are cleanly released for reclaim rather than dying mid-execution and
leaving an orphaned container attached to a customer's production system.

## 4. Rollback

Application rollback is redeploying the previous image tag — safe at any time, because
expand/contract guarantees the previous version works against the current schema.

**Schema rollback is not a thing we do.** A bad migration is corrected by rolling forward with
a new migration. This is why the expand/contract discipline is non-negotiable: it is what makes
application rollback safe without ever needing a schema rollback.

Rollback triggers: failed health checks, error rate above threshold, failed smoke tests, or a
judgement call. The decision is made quickly and reviewed afterwards, not debated during the
incident.

## 5. Zero-downtime requirements

Rolling deploys with health gating. Graceful shutdown: stop accepting new work, finish in-flight
requests within a timeout, close connections cleanly. Connection draining at the load balancer.
Database connection pools sized so that N instances during a rolling deploy do not exceed
Postgres's connection limit — a limit that is easy to forget until a deploy doubles the instance
count momentarily and everything fails to connect.

API changes are backward compatible within `/api/v1` ([`../api/conventions.md`](../api/conventions.md) §8),
so old and new instances can serve simultaneously during a roll.

## 6. Topology

```
Cloudflare (CDN, WAF, TLS, rate limiting at the edge)
  -> web        (stateless, autoscaled)
  -> api        (stateless, autoscaled)
       -> Postgres (managed, HA, read replicas for analytics)
       -> Redis    (managed, HA)
       -> S3/R2
  -> workers    (autoscaled on queue depth; engine containers in an ISOLATED SUBNET
                 with no route to Postgres, Redis, storage, or metadata endpoints)
  -> scheduler  (single leader via Redis lock)
```

The worker subnet isolation is a deployment-level control, not just a code-level one
([`../security/worker-security.md`](../security/worker-security.md) §3). The code guard will
eventually have a bug; the network rule is what holds when it does.

## 7. Secrets in deployment

Injected from the secrets manager at runtime. Never baked into an image, never in an
environment file in the repository, never in CI logs. CI holds only the credentials needed to
deploy, scoped to that purpose, and rotated on a schedule.

## 8. Post-deploy verification

Automated smoke tests against the deployed environment: health endpoints, login, a read of a
core resource, a queued job completing. Error rates and latency watched for a defined window
before the deploy is considered settled. A deploy that passes health checks but doubles p99
latency is a failed deploy.
