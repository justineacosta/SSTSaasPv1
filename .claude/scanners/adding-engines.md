# Adding a testing engine

> **Status: Process defined; the runner it depends on is Not Implemented (Phase 4).**

Adding an engine must not require changing the platform. If it does, the contract has leaked
and the fix belongs in the contract.

## Checklist

**1. Design**
- [ ] Which asset types? Which profiles? What is the failure mode if the target is hostile?
- [ ] What are the fingerprint inputs for each check? (Hardest question — decide it first.)
- [ ] Does an existing engine already cover this? Overlapping engines produce related
      findings and confuse triage.

**2. Catalogue**
- [ ] Add each check to the check taxonomy: canonical title, description template, CWE,
      OWASP category, base severity, remediation guidance, references. **Findings text comes
      from here, not from engine code.**

**3. Implement**
- [ ] `packages/engines/<id>/` (TypeScript, using `engine-sdk`) or `workers/engines/<id>/`
      (Python, using `python-sdk`).
- [ ] Descriptor with `configurationSchema`, semver version, capabilities, resource hints.
- [ ] All HTTP through the SDK's guarded client. **Never a raw socket or bare fetch.**
- [ ] Emit `progress`, `log`, `finding`, `artifact`, and a mandatory `complete`.
- [ ] Honour `constraints`: timeout, request budget, per-host rate limit.
- [ ] Handle `SIGTERM` promptly and stop outbound traffic.
- [ ] Set `confidence` honestly. Set `fingerprintInputs` deterministically.

**4. Package**
- [ ] Dockerfile: minimal base, pinned by digest, non-root, no shell where avoidable.
- [ ] No credentials, no platform config, no database access.

**5. Test**
- [ ] Unit tests per check against recorded fixtures.
- [ ] Integration against the vulnerable target in the compose stack — must find the
      planted issues.
- [ ] **False-positive suite** against a clean target — must find nothing.
- [ ] Fingerprint stability across runs and across a patch version bump.
- [ ] Constraint compliance: timeout honoured, rate limit respected, cancellation prompt.
- [ ] Event schema conformance.

**6. Register**
- [ ] Registry entry and seed row; `engines` entitlement values updated in plan seeds.
- [ ] Marked `BETA` initially and gated by a feature flag.

**7. Surface**
- [ ] Configuration UI generated from `configurationSchema` — no bespoke form.
- [ ] Engine appears in scan creation for supported asset types only.
- [ ] Findings render correctly, including evidence types the engine emits.

**8. Document**
- [ ] Row in [`architecture.md`](architecture.md) §2 with an honest status.
- [ ] Row in [`../product/feature-map.md`](../product/feature-map.md).
- [ ] User documentation covering what it checks and what it does not.
- [ ] ADR if the engine required any contract change.

## Definition of done

The engine finds real issues on a deliberately vulnerable target, finds nothing on a clean
one, deduplicates correctly across repeated runs, respects its constraints, stops when
cancelled, and required **zero** changes to the queue, worker orchestrator, normalisation,
deduplication, evidence, risk, API, or UI.
