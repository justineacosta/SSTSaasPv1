# Sentinel

A multi-tenant SaaS platform for security testing, penetration test management, and
vulnerability management.

Customers register the assets they own, **prove they own them**, define scope, run automated and
manual security testing against that scope, triage the resulting findings, retest them, and
produce reports. Automated scans and human penetration testing feed one normalised finding
model, with one lifecycle, one risk model, and one reporting layer.

---

## Current status — Phase 0 complete

> **This repository contains architecture and documentation only. There is no application code
> yet. Nothing here runs, scans, stores, authenticates, or bills.**

| Phase | Scope | Status |
|---|---|---|
| **0** | Repository audit, architecture, documentation foundation | **Complete** |
| 1 | Monorepo, CI, config, database, queue, storage, design system | Not started |
| 2 | Authentication, MFA, organisations, RBAC, invitations | Not started |
| 3 | Projects, assets, ownership verification, scope, audit log | Not started |
| 4 | Queue, workers, container isolation, scan lifecycle, realtime | Not started |
| 5 | Web security engine, findings, deduplication, evidence, risk | Not started |
| 6–12 | API security, pentest workspace, reports, integrations, billing, enterprise, more engines | Not started |

Authoritative status: [`.claude/product/roadmap.md`](.claude/product/roadmap.md).

**Known blockers:** the Docker daemon is not running on the development host (required for the
local stack); Go and Terraform are not installed (both deferred, neither architectural).
Detail: [`.claude/architecture/repository-audit.md`](.claude/architecture/repository-audit.md).

---

## What is designed

Phase 0 produced a complete architectural specification — 50 documents covering system
architecture, the domain and database model, the security model, the product definition, the
UI/UX system, the scanner contract, API conventions, engineering practice, operations, and ten
architecture decision records.

Start here:

| Document | What it covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Project identity, stack, critical rules — read first |
| [`.claude/README.md`](.claude/README.md) | Documentation map |
| [`.claude/architecture/overview.md`](.claude/architecture/overview.md) | How the system fits together |
| [`.claude/architecture/repository-audit.md`](.claude/architecture/repository-audit.md) | Phase 0 audit and toolchain reality |
| [`.claude/security/overview.md`](.claude/security/overview.md) | Security model and control status |
| [`.claude/security/scope-controls.md`](.claude/security/scope-controls.md) | **The control that makes this product safe to operate** |
| [`.claude/product/roadmap.md`](.claude/product/roadmap.md) | What is built and what is not |
| [`.claude/decisions/`](.claude/decisions/) | Why it is the way it is |

## Architecture

A pnpm + Turborepo monorepo. `apps/web` is Next.js. `apps/api` is a modular-monolith NestJS REST
API. Long-running and dangerous work never runs in the API: it is queued to Redis/BullMQ and
executed by worker processes that run each scan engine in a resource-capped, network-isolated
ephemeral container. PostgreSQL is the system of record via Prisma. Evidence and reports live in
S3-compatible object storage. Realtime updates reach the browser over SSE. Stripe is the
authority on billing; the database holds a projection.

```
Cloudflare -> Next.js web -> NestJS API -> PostgreSQL
                                |  |
                                |  +-> Redis -> BullMQ -> workers -> engine containers -> targets
                                |                            |
                                +---- SSE <--- pub/sub ------+
                                                             +-> S3 / R2 evidence
```

**Stack:** TypeScript · Next.js · NestJS · PostgreSQL · Prisma · Redis · BullMQ · Docker ·
S3/R2 · Stripe · Vitest · Playwright · OpenTelemetry.

## The rule that shapes everything

This platform sends attack traffic at network targets on behalf of paying customers. Scope
enforcement is not a feature — it is the control that keeps the product from being an attack
service.

**No scan runs against a target the customer has not proven they control**, and scope is
evaluated twice: once at the API for fast feedback, and again inside the worker immediately
before execution, because that is the check adjacent to the packet leaving the machine.
See [ADR-0009](.claude/decisions/ADR-0009-scope-enforcement.md).

## Getting started

There is nothing to run yet. [`.claude/development/setup.md`](.claude/development/setup.md)
specifies the intended local setup that Phase 1 must satisfy.

## Contributing

[`.claude/development/coding-standards.md`](.claude/development/coding-standards.md) and
[`.claude/development/pull-request-rules.md`](.claude/development/pull-request-rules.md).

Two rules matter more than the rest. **Documentation ships with the code change** — a stale
document is a defect. And **nothing is described as implemented until it has been run and
verified**; the vocabulary is Implemented / Partially Implemented / Not Implemented / Blocked,
and a file that exists is not a feature that works.

## Security

Do not report vulnerabilities through public issues. A `security@` contact and a published
vulnerability disclosure policy are prerequisites for production launch
([`.claude/security/incident-response.md`](.claude/security/incident-response.md) §5).

## Licence

MIT. See [LICENSE](LICENSE).
