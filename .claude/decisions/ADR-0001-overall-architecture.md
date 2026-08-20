# ADR-0001 — Modular monolith with detached workers

**Status:** Accepted · **Date:** 2026-08-20

## Context

We are building a multi-tenant security testing SaaS from an empty repository, with a single
developer initially and an intended growth path to an enterprise product. The domain is
strongly relational: an organisation owns projects, which own assets, which have versioned
scope, which constrains scans, which produce findings, which carry evidence and occurrences.

One part of the system is genuinely different from the rest: executing security tests against
hostile third-party targets. That work is slow, resource-hungry, and processes attacker-
controlled output.

## Decision

A **modular monolith** for the application (`apps/api`, NestJS, one deployable with bounded
modules and enforced import boundaries), with **detached worker processes** for queued
execution, and **ephemeral per-job containers** for the engines themselves.

The split is drawn along the trust and resource boundary, not along the domain.

## Alternatives considered

**Microservices per domain (findings, scans, assets, billing).** Rejected. Almost every
meaningful operation spans several of these — creating a finding touches assets, scans,
evidence, risk, audit, notification, and entitlement. Distributing that buys network partitions,
distributed transactions, and eventual-consistency bugs, and sells transactional integrity and
foreign keys, which are the properties keeping tenant data correct. The organisational benefit
of microservices — independent team deployment — does not apply to a one-team product.

**Pure monolith including scan execution.** Rejected. Running attacker-facing code in the same
process as the one holding database credentials is indefensible for this product specifically.
It also makes a long scan block a web request and ties scanner scaling to API scaling.

**Serverless functions.** Rejected. Scans run for minutes to hours, exceeding typical execution
limits; container-level isolation control is limited; cold starts hurt an interactive API; and
per-invocation pricing is unpredictable for our workload shape.

## Consequences

**Positive.** Transactional integrity across the domain. One codebase to reason about, one
deploy for the application, straightforward local development. Shared types end-to-end through
`packages/contracts`. Untrusted execution is genuinely isolated. Workers scale independently on
queue depth.

**Negative.** The monolith is a single scaling and failure unit for the API tier — mitigated by
statelessness and horizontal scaling. Module boundaries can erode; mitigated by enforced import
boundaries in lint. Extracting a service later is real work, though the module boundaries make
it tractable if a genuine need appears.

**Neutral.** Team growth may eventually justify extraction. The decision is revisited if a
module develops materially different scaling or availability requirements — not because of
headcount alone.
