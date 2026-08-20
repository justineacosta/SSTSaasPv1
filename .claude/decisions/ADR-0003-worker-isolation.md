# ADR-0003 — Engine isolation in ephemeral containers

**Status:** Accepted · **Date:** 2026-08-20

## Context

Scan engines process output from targets we do not control. A hostile target can return
malformed TLS handshakes, enormous responses, malicious HTML, crafted headers, and payloads
designed to exploit parsers. We must assume an engine will eventually be compromised by
something it parses.

Engines also need genuine network egress — that is their job — which makes them the one
component in the system that is both internet-facing outbound and processing untrusted input.

## Decision

Three distinct trust levels, with the boundary enforced by infrastructure rather than only by
code:

1. **Worker process** — semi-trusted, long-lived, holds database, queue, and storage
   credentials. Orchestrates. Never parses target output directly.
2. **Engine container** — **fully untrusted**, ephemeral, one per job, destroyed afterwards
   without exception. Non-root, read-only root filesystem, all capabilities dropped, seccomp
   and AppArmor profiles, no host mounts, no host namespaces, CPU/memory/PID/wall-clock caps.
   **Holds no credentials and knows no tenant identity.**
3. **Egress network** — engine containers sit on a dedicated network with **no route** to
   Postgres, Redis, object storage, the API, internal subnets, or cloud metadata endpoints.

Workers do **not** hold the Docker socket. Container execution goes through a narrow execution
service.

## Alternatives considered

**Engines as in-process libraries in the worker.** Rejected. A parser exploit becomes immediate
access to database and storage credentials. This is the failure mode the entire design exists
to prevent.

**Separate VMs per scan.** Rejected for now. Stronger isolation, but start latency in tens of
seconds and materially higher cost per scan. Containers with dropped capabilities, seccomp, and
network isolation are a reasonable position at this stage. Revisit if we run engines that
require kernel-level operations, or if a container escape is demonstrated against our
configuration.

**Give workers the Docker socket for simplicity.** Rejected. Socket access is equivalent to
host root, so a worker compromise would become a host compromise. The execution service
indirection also makes the container runtime swappable (Docker locally, Kubernetes Jobs or
Fargate in production) without touching worker logic.

**gVisor / Firecracker.** Attractive middle ground and a likely future step. Deferred to keep
the initial operational surface smaller; the execution service abstraction means adopting one
later does not change worker code.

## Consequences

**Positive.** A compromised engine reaches nothing of value: no credentials, no tenant
identity, no route to our infrastructure. Resource caps prevent one scan starving the host.
Ephemeral containers mean no state persists between jobs. Engines can be written in any
language ([ADR-0010](ADR-0010-engine-contract.md)).

**Negative.** Container start latency of a few seconds per scan — negligible against scans
measured in minutes. Higher operational complexity: image builds, registry, reaping orphans,
network policy. Debugging a failed engine is harder when the container is already destroyed;
mitigated by streaming logs out during execution rather than reading them afterwards.

**Neutral.** Network isolation must be verified by test **from inside the container**
([`../development/testing.md`](../development/testing.md) §3), not assumed from configuration.
Configuration drifts; tests do not.
