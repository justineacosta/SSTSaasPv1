# ADR-0009 — Proof of ownership and double scope evaluation

**Status:** Accepted · **Date:** 2026-08-20

## Context

This is the decision that distinguishes this product from ordinary SaaS. We send attack traffic
at network targets on behalf of paying strangers. Without controls, that is an attack service
with an invoice attached, and the harm lands on third parties who never agreed to anything.

Three distinct failure modes, needing three different controls: **malicious use** (a customer
registers a domain they do not own), **careless use** (a mistyped CIDR sweeps a neighbouring
network), and **stale authorisation** (a scan queued while in scope executes twenty minutes
later after scope narrowed or the organisation was suspended).

## Decision

**No scan executes against a target the customer has not proven they control, and scope is
evaluated twice — at the API and again inside the worker immediately before execution.**

1. **Proof of ownership.** `Asset.ownershipVerifiedAt` is null until proven. DNS TXT/CNAME for
   domains; a `/.well-known/` file, meta tag, or header for URLs; OAuth grant for repositories;
   cloud role or tagging for cloud resources. **IP ranges and CIDRs are never self-service** —
   they require a signed authorisation document, RIR/WHOIS correlation, and human operator
   review. Verification is re-checked periodically; domains change hands.
2. **A global deny list no customer can override**, covering private and loopback ranges, all
   cloud metadata endpoints, our own infrastructure, and an operator-maintained blocklist.
3. **Versioned, default-deny scope rules**, deny-wins, with a **reason returned for every
   refusal**.
4. **Double evaluation.** The API check gives immediate user feedback. **The worker check is the
   authoritative one**, because it is the decision adjacent to the packet leaving the machine.
   It re-reads organisation status, subscription, asset verification, current scope version, and
   cancellation from the database.
5. **Safe by default.** `SAFE` profile default, non-destructive checks, per-target rate limits;
   `AGGRESSIVE` requires a separate permission and explicit per-scan opt-in.

## Alternatives considered

**Terms-of-service acceptance only ("I confirm I own this target").** Rejected. It is the
industry's common approach and it is a legal shield, not a control. It stops nobody and protects
nobody.

**Ownership verification only, checked once at scan creation.** Rejected. It closes malicious
use but not the stale-authorisation window. Time passes between enqueue and execution, and the
things that authorise a scan can all change within it.

**Worker-side check only.** Rejected. Technically sufficient, but a user discovering their scope
error minutes later via a failed job is a bad experience that pushes people to widen scope
blindly until something works.

**Self-service IP range verification.** Rejected. The asymmetry is deliberate: a wrong domain is
usually a wasted scan; a wrong CIDR is an incident involving an organisation that has never
heard of us.

## Consequences

**Positive.** We can demonstrate, per scan, what authorised it and when — including the exact
scope version. Stale authorisation cannot cause traffic. Third parties are protected by
mechanism, not by promise. The verified asset inventory is also what makes coverage reporting
trustworthy, so a safety control doubles as a product feature.

**Negative.** **Verification is real onboarding friction and will cost signups.** Accepted
deliberately, and mitigated with clear per-method instructions, a copyable token, live re-check,
and background re-verification so a user who adds a DNS record an hour later is verified without
returning. Manual review for IP ranges needs staffed operational capacity. Double evaluation
costs an extra database read per job — irrelevant.

**Neutral.** Scanning an unverified or out-of-scope target is classified **SEV1**, equal to a
data breach ([`../security/incident-response.md`](../security/incident-response.md) §1), and
the scope-denial rate is monitored as the platform's primary abuse signal.
