# Testing strategy

> **Status: Designed. Not Implemented.** Test infrastructure lands in Phase 1; every feature
> after that ships with its tests or does not ship.

## 1. Principle

Test at the layer where the thing can actually fail, and **do not mock the thing you are
trying to verify**. A test that mocks Prisma proves your mock works. A test that mocks the
authorization guard proves nothing about authorization. Integration tests run against a real
Postgres, a real Redis, and a real MinIO through Testcontainers, because the failures that
matter in this system — constraint violations, transaction behaviour, RLS, presign semantics,
queue reclaim — are precisely the ones a mock hides.

## 2. Layers

| Layer | Tool | Runs against | Target |
|---|---|---|---|
| Unit | Vitest | Pure functions, domain logic, state machines, fingerprinting, risk, scope evaluation | Fast, no I/O |
| Integration | Vitest + Testcontainers | Real Postgres, Redis, MinIO; full API through the HTTP layer | The bulk of the suite |
| E2E | Playwright | Running stack in Docker | The journeys in [`../product/user-flows.md`](../product/user-flows.md) |
| Security | Vitest, generated | Tenant isolation, authorization matrix | **Release-blocking** |
| Engine | Vitest + fixtures + vulnerable target | Each scan engine | Per engine |
| Contract | Vitest | OpenAPI diff, Zod schema conformance | CI gate |
| Visual | Playwright | Storybook and key routes | Regression only |

## 3. What must be tested

**Domain logic (unit).** Finding state transitions — every valid transition and every invalid
one. Fingerprint normalisation, including the path-ID and query-value rules. Risk score
composition. Scope evaluation, table-driven over allow/deny/port/environment/profile including
overlapping and contradictory rules. CVSS parsing. SLA calculation. Entitlement resolution
with overrides.

**API (integration).** Every endpoint: happy path, validation failure, and the full
authorization matrix. Transactions roll back completely on failure, including their audit
events. Pagination traverses every row exactly once under concurrent inserts. Filters do not
leak across tenants. Idempotency keys behave. Optimistic concurrency returns 409.

**Security (release-blocking).** Two generated suites:

- **Tenant isolation** — a resource registry drives assertions that Tenant A gets 404 for
  Tenant B's IDs across read, list, update, delete, evidence download, presigned URL, report
  download, search, export, and SSE subscription. **Adding a tenant-owned resource without
  registering it fails CI**, so coverage cannot rot as the product grows.
- **Authorization matrix** — generated from the route table: 401 unauthenticated, 403 without
  permission, 404 cross-tenant, success with permission. A new endpoint gets tests
  automatically.

**Scope and abuse (release-blocking).** Unverified asset refused at API *and* at worker.
Global deny list refuses metadata endpoints, loopback, and our own infrastructure even when a
tenant explicitly allows them. Scope narrowed after enqueue is refused by the worker.
Suspension after enqueue is refused. SSRF: DNS-rebinding target, redirect to internal address,
redirect chain to metadata — all refused and logged.

**Workers and queue.** Payload/database tenant mismatch fails loudly. Cancelled scan does not
execute. Timeout kills the container and reports `TIMED_OUT` with partial results retained.
Retry only for transient causes; **never** for authorization or scope failures. Orphaned
containers are reaped. Per-organisation concurrency caps hold under parallel load. An engine
container provably cannot reach Postgres, Redis, storage, or metadata endpoints — asserted from
inside the container.

**Engines.** Detection tests against the vulnerable target (must find the planted issues), a
**false-positive suite** against a clean target (must find nothing), fingerprint stability
across runs and patch versions, and constraint compliance.

**Billing.** Against the Stripe CLI in test mode, never against a mock of Stripe's behaviour:
signature rejection, stale timestamp rejection, duplicate event no-op, out-of-order events
ignored, entitlement projection per lifecycle event, over-limit downgrade preserving data.

**Frontend.** Component states (loading, empty, error, permission) in Storybook; `axe-core` on
every route; keyboard-only traversal of primary journeys; no horizontal page overflow at any
breakpoint; a finding whose title contains `<script>` renders as text.

## 4. Fixtures

E2E and integration fixtures are created **through the real API**, not by direct database
insert, so the tests exercise the code paths that will run in production — including
validation, authorization, and audit. A fixture created by raw insert can be in a state the
application can never produce, and tests built on it prove nothing.

Every test gets its own organisation, so tests are parallel-safe and cross-tenant assertions
have a real second tenant to assert against.

## 5. Coverage

Coverage is a diagnostic, not a target. The floors that are enforced: domain logic ≥ 90%,
API handlers ≥ 80%, security suites **100% of the resource registry and the route table** —
that last one is not a percentage of lines but a completeness check, which is the only kind of
coverage number worth gating on.

Untested code paths in scope enforcement, tenant isolation, or authorization block the merge
regardless of the aggregate number.

## 6. CI

The intended pipeline:

```
install -> lint -> typecheck -> unit -> integration -> security -> build -> e2e -> container scan
```

**What `.github/workflows/ci.yml` runs today** (Task 14), which is not yet all of it:

```
install -> format -> lint -> typecheck -> unit -> check:specs -> stack up -> integration
        -> build -> check:openapi -> check:registry -> playwright install -> e2e
```

`security` and `container scan` are not in it: the security suites are Phase 2/3 (there is no
authorization matrix to generate and no tenant-owned REST resource to assert over), and no
container is built yet. `check:specs`, `check:openapi` and `check:registry` are the three
mechanical checks Task 14 added — respectively that every `*.spec.*` file is claimed by exactly
one Vitest project, that the committed OpenAPI document matches what the contracts generate, and
that the tenant resource registry has not rotted
([`migrations.md`](migrations.md) §5).

`check:specs` sits immediately after the unit tests because it is the check that says whether
they ran anything: a spec matching no project executes nothing while `--passWithNoTests` prints
green.

Security suites run on every pull request, not nightly. The full E2E suite runs on pull
requests to `main`; a smoke subset runs on every push. Flaky tests are quarantined and fixed,
never retried into passing — a retried test is a test that no longer tells you anything.

**One live exception to that last sentence, recorded rather than hidden:**
`apps/web/playwright.config.ts` sets `retries: 2` under CI. That was Task 13's decision and it
predates this stage existing anywhere but one developer's machine; now that the E2E stage runs
on every push, it is a real conflict with the rule above and it belongs in front of a reviewer
rather than in a config file nobody re-reads. The argument for keeping it is that a cold Linux
runner starting a fresh production build has startup races a developer's warm machine does not;
the argument against is the rule above, which exists because a retried test stops telling you
anything. Unresolved.
