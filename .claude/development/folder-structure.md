# Folder structure

> **Status: Designed. Not Implemented.** Created in Phase 1.

```
SSTSaasPv1/
├── apps/
│   ├── web/                     Next.js — marketing + application
│   │   ├── app/
│   │   │   ├── (marketing)/     public site
│   │   │   ├── (auth)/          login, register, reset, mfa, invitations
│   │   │   ├── (onboarding)/    the wizard
│   │   │   ├── (app)/           authenticated product, app shell layout
│   │   │   └── api/             BFF only: session relay, csp-report, health
│   │   ├── components/
│   │   │   ├── ui/              design system primitives
│   │   │   ├── patterns/        DataTable, PageHeader, EmptyState, ConfirmDialog
│   │   │   └── domain/          FindingRow, SeverityIndicator, ScanProgress
│   │   ├── hooks/  lib/  providers/  styles/
│   │   └── e2e/                 Playwright specs
│   │
│   ├── api/                     NestJS modular monolith
│   │   └── src/
│   │       ├── common/          guards, interceptors, filters, decorators, pipes
│   │       ├── infrastructure/  config+logger, prisma, redis, storage, queue, mail, stripe
│   │       └── modules/         one folder per bounded module
│   │           ├── health/      live / ready / detailed probes (Phase 1)
│   │           └── findings/    controller, service, repository, dto/, tests
│   │
│   ├── worker-node/             BullMQ consumer + TypeScript engines
│   ├── worker-python/           BullMQ consumer + Python engines
│   └── scheduler/               leader-elected periodic jobs
│
├── packages/
│   ├── db/                      Prisma schema, migrations, tenant client, seeds
│   ├── contracts/               Zod schemas + inferred types (the spine)
│   ├── engine-sdk/              TypeScript engine contract + guarded HTTP client
│   ├── ui/                      shared design tokens and primitives
│   ├── observability/           logger, tracing, metrics, redaction
│   ├── storage/                 S3-compatible adapter, tenant-prefixed keys
│   └── config/                  env schema, tsconfig/eslint presets
│
├── workers/python-sdk/          Python engine contract implementation
│
├── infra/
│   ├── docker/                  Dockerfiles, compose stacks
│   └── terraform/               IaC (Phase 11)
│
├── docs/                        public product and API documentation
├── .claude/                     internal engineering documentation
├── .github/workflows/           CI/CD
├── CLAUDE.md  README.md  .env.example
├── package.json  pnpm-workspace.yaml  turbo.json
```

## Rules

**`packages/contracts` is the spine.** Request and response shapes, engine job payloads,
finding shapes, permission strings, and event payloads are defined once as Zod schemas and
imported by web, api, and workers. A shape change that breaks a consumer breaks the
typecheck — which is the point, and the reason this package must never import from an app.

**Dependency direction is one-way.** Apps depend on packages. Packages depend on other
packages. **No package ever imports from an app**, and no app imports from another app. An
import-boundary lint rule enforces this, because dependency cycles in a monorepo are easy to
create by accident and painful to unpick later.

**Modules are bounded.** Inside `apps/api/src/modules/`, a module owns its controller, service,
repository, DTOs, and tests. Cross-module access goes through the other module's **service**,
never its repository — the repository is the module's private data access, and reaching into
it from outside couples two modules to one schema.

**Feature-first, not type-first.** Everything about findings lives under `findings/`. A global
`services/` or `controllers/` folder scatters one feature across four places and makes it
impossible to see what a change touches.

**Colocated tests.** `*.spec.ts` next to the code it tests, `*.integration.spec.ts` for
database-backed tests, `e2e/` for Playwright. A test far from its subject is a test that gets
forgotten when the subject moves.

**Engines are plugins.** An engine lives entirely under its own folder and touches no platform
code ([`../scanners/adding-engines.md`](../scanners/adding-engines.md)). If adding an engine
requires editing the worker, the queue, or the UI, the contract has leaked.

**The storage adapter is a package, not API infrastructure.** Workers upload evidence from
Phase 5 onward, and no app may import another app, so the adapter has to live where both
can reach it.

**`apps/api/src/infrastructure/prisma` is the only place in an app that may import the
unscoped Prisma client.** It constructs the single base client the process owns, so that
`createTenantClient` can wrap it per request and a handler can only ever receive a
tenant-scoped one. The exemption is scoped to that directory in `eslint.config.js`; anywhere
else the import fails the build.

**`apps/api/src/app-setup.ts` holds `configureApp`, not `main.ts`.** Everything that shapes
the HTTP surface — global prefix and its health exclusion, URI versioning, the global filter
and interceptor, the Nest logger bridge — lives in a module the integration test can import
without also running `bootstrap()` and binding a port. A bootstrap that only exists inside
`bootstrap()` is a bootstrap no test has ever seen.
