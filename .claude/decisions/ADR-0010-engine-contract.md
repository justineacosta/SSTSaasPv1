# ADR-0010 — Language-agnostic engine contract over stdio

**Status:** Accepted · **Date:** 2026-08-20

## Context

The roadmap names twelve engine categories: web, API, SAST, dependency, container, cloud,
network, mobile, LLM, performance, load, and accessibility. Their ecosystems differ — network
tooling favours Go, analysis and ML tooling favours Python, web tooling favours Node. Engines
also run untrusted ([ADR-0003](ADR-0003-worker-isolation.md)), so they must not be able to reach
into the platform.

A practical constraint: **Go is not installed on the current development host**
([`../architecture/repository-audit.md`](../architecture/repository-audit.md) §3).

## Decision

The engine contract is a **JSON protocol over stdio**, not a language interface. An engine is
any executable that reads a job document on stdin and writes newline-delimited JSON events on
stdout.

- **Descriptor** — static metadata plus a JSON Schema for its configuration, registered at build
  time and validated at scan creation and again in the worker against the pinned version.
- **Input** — pre-resolved, pre-authorised targets, a profile, config, and constraints
  (timeout, request budget, per-host rate limit). **No credentials, no database URL, no tenant
  identity.** An engine cannot learn whose infrastructure it is testing.
- **Output** — `progress`, `log`, `finding`, `artifact`, `metric`, and a **mandatory**
  `complete`. An engine exiting without `complete` is `FAILED`, never "succeeded with no
  findings" — silence must never be mistaken for a clean result.
- **Engines emit candidate findings only.** Severity, risk, identity, and text come from the
  platform's check taxonomy, so two engines detecting the same issue produce comparable output.
- The engine's one contribution to identity is `fingerprintInputs`
  ([`../scanners/finding-deduplication.md`](../scanners/finding-deduplication.md)).

SDKs exist for TypeScript (`packages/engine-sdk`) and Python (`workers/python-sdk`), both
wrapping the same protocol and providing the guarded HTTP client that enforces SSRF protection
and rate limits.

**Go engines are deferred**, not designed out. No Go toolchain exists on the current host, and
the first-party engines (web, API) are naturally TypeScript. Because the contract is a wire
protocol, adding a Go engine later requires no platform change.

## Alternatives considered

**A TypeScript interface engines implement in-process.** Rejected. It forces every engine into
Node, and it puts untrusted parsing in the worker process holding credentials — contradicting
ADR-0003.

**gRPC between worker and engine.** Rejected. Heavier, requires a network listener in the engine
container (which we would rather not have at all), and needs schema tooling in every language.
Stdio needs nothing.

**A generic plugin system with dynamic loading.** Rejected. Loading untrusted code into a
trusted process is the failure mode we are designing against.

**Let engines assign final severity and identity.** Rejected. Severity would then mean whatever
each engine author thought, and the same vulnerability found twice would deduplicate
inconsistently. Normalisation is a platform concern precisely so findings are comparable.

## Consequences

**Positive.** Engines can be written in any language that can write JSON to stdout. Zero coupling
to the platform, which is what makes container isolation meaningful. Adding an engine touches
only its own folder plus a registry entry. Engines are trivially testable — feed a job on stdin,
assert the event stream. Configuration UI is generated from the schema, so no frontend work per
engine.

**Negative.** Serialisation overhead per event — negligible against scans measured in minutes.
Two SDKs to maintain, and a third if Go arrives. Protocol versioning must be handled explicitly
as engines evolve; the descriptor's semver and the pinned `engineVersion` on each scan address
this.

**Neutral.** Go support is a host-setup task, not an architectural one. If Go engines are wanted,
installing the toolchain and writing against the documented protocol is the whole job.
