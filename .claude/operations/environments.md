# Environments

> **Status: Designed. Not Implemented.** Development in Phase 1; staging and production in
> Phase 11 alongside IaC.

## 1. The four environments

| | Development | Test | Staging | Production |
|---|---|---|---|---|
| Where | Developer machine | CI runner | Cloud | Cloud |
| Data | Local, disposable | Ephemeral per run | Synthetic only | Real customer data |
| Database | Docker Postgres | Testcontainers | Managed, small | Managed, HA, replicas |
| Redis | Docker | Testcontainers | Managed | Managed, HA |
| Storage | MinIO | MinIO container | R2/S3 bucket | R2/S3, versioned, replicated |
| Email | Mailpit (nothing leaves) | Captured in memory | Real provider, restricted recipients | Real provider |
| Stripe | Test mode | Test mode | Test mode | **Live mode** |
| Scanning | Local vulnerable target only | Local target only | Owned staging assets only | Customer verified assets |
| Secrets | `.env`, local placeholders | CI variables | Secrets manager | Secrets manager, separate account |
| Logging | Pretty, debug | Silent unless failing | JSON, info | JSON, info, shipped |
| Sentry | Off | Off | On | On |

## 2. Hard separations

**Production secrets never exist outside production.** Not in a developer's `.env`, not in CI,
not in staging. Staging has its own credentials for its own resources, and a staging compromise
must not reach production ([`../security/secrets.md`](../security/secrets.md) §1).

**Production data never leaves production.** Staging is populated with synthetic data generated
by a script, never with a production dump. A production dump in staging is a copy of every
customer's unfixed vulnerabilities sitting in a lower-security environment — for this product
specifically, that is close to the worst thing we could do.

**Cloud accounts are separate.** Production runs in its own account or project with its own IAM
boundary, so a misconfigured staging role cannot reach production storage.

**Scanning targets are constrained per environment.** Development and test can only reach the
local vulnerable target. Staging can only reach assets we own. Only production scans customer
assets, and only verified ones.

## 3. Configuration

All configuration comes from environment variables, validated by a Zod schema at boot. A
missing or malformed variable **crashes startup** naming the variable — a service must never
run half-configured and fail confusingly later.

`NODE_ENV` is `development`, `test`, or `production`. A separate `APP_ENV`
(`development`/`test`/`staging`/`production`) distinguishes staging from production, since both
run with `NODE_ENV=production` and behave differently in ways that matter — feature flag
defaults, log verbosity, whether the scanning deny list includes our own staging hosts.

`.env.example` documents every variable with a safe placeholder and a comment saying what it is
for. It is committed. `.env` is not, and never will be.

## 4. Production configuration that differs from development

Development defaults are not production defaults, and assuming otherwise is a common way to
ship an insecure service:

| Setting | Development | Production |
|---|---|---|
| CORS | Permissive to localhost | Explicit allowlist, no wildcard with credentials |
| CSP | Report-only while iterating | Enforcing, nonce-based |
| Cookies | `Secure` relaxed for http://localhost | `Secure`, `__Host-` prefix, strict |
| Rate limits | Generous | Tuned, fail-closed on auth |
| Error detail | Full stack to client | Generic + request ID only |
| Source maps | Served | Uploaded to Sentry, not served |
| Database pool | Small | Sized to instance count and connection limit |
| Worker concurrency | 1–2 | Sized to the fleet |
| Migrations | On demand | Separate deploy stage, never on boot |
| Log level | `debug`, pretty | `info`, JSON, shipped |

## 5. Promotion

```
feature branch -> PR (CI: lint, typecheck, unit, integration, security, build, e2e)
   -> main -> auto-deploy to staging -> smoke tests
   -> manual approval -> production (migrations, then rolling deploy, then health gate)
```

Production deployment requires a green pipeline and an explicit human approval. Rollback is
always available because migrations are expand/contract
([`../development/migrations.md`](../development/migrations.md) §2), so the previous
application version still works against the current schema.
