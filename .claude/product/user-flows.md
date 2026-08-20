# User flows

The journeys the product must support end to end. Each is an E2E test target; see
[`../development/testing.md`](../development/testing.md).

## 1. Signup to first finding — the flow that decides adoption

```
Marketing site -> /register -> verify email -> onboarding wizard
   -> create organisation
   -> invite team (skippable)
   -> create project
   -> add asset
   -> VERIFY ASSET OWNERSHIP        <- the only unskippable security step
   -> define scope (prefilled from the verified asset)
   -> choose profile (SAFE default)
   -> run first scan
   -> watch live progress
   -> review findings
   -> generate report
```

Time to first real finding is the metric that matters. Every step except ownership
verification is skippable and resumable; progress persists server-side on the
`OnboardingState` record so a user can close the tab and return.

Ownership verification is where users drop off, so it gets disproportionate design
attention: clear instructions per method, a copyable token, a "check now" button with real
feedback, an explanation of *why* we require it, and a queued re-check so a user who adds
the DNS record an hour later is verified automatically without returning.

## 2. Continuous scanning (Marcus)

```
Scheduled scan runs -> new findings deduplicated against existing
   -> only genuinely new findings notify
   -> triage queue sorted by risk x confidence
   -> bulk actions: assign, mark false positive, accept risk
   -> assigned findings post to Jira/Slack
   -> engineer fixes -> retest -> finding resolves
```

The critical property: a rescan that finds the same twelve issues produces **zero** new
findings and **zero** notifications — it updates `lastSeenAt` and appends occurrences.
Getting this wrong makes the product unusable at scale, and it is the single most common
way tools in this category fail.

## 3. Pentest engagement (Priya)

```
Create engagement -> define scope + methodology -> assign testers
   -> work test cases, marking pass/fail/NA
   -> record manual findings with evidence as discovered
   -> automated scans run alongside, into the same finding pool
   -> client reviews findings live during the engagement
   -> generate technical + executive reports
   -> engagement closes
   ...weeks later...
   -> client requests retest -> retest only failed findings
   -> generate retest report showing before/after
```

The engagement and the scanner feed **one** finding pool. That is the product's core claim.

## 4. Remediation (Sofia)

```
Slack/Jira notification -> open finding
   -> read reproduction steps and request/response evidence
   -> fix -> mark REMEDIATED -> request retest
   -> retest PASSED -> RESOLVED     (or FAILED -> REOPENED, back to Sofia)
```

Sofia can dispute: `finding.update` lets her comment and propose `FALSE_POSITIVE`, which
routes to someone with `finding.triage` rather than silently closing. A finding is never
resolved on assertion alone — only a passing retest resolves it.

## 5. Posture review (David)

Dashboard -> risk trend, severity distribution, coverage, SLA compliance, remediation
velocity -> generate executive report -> share.

## 6. Compliance evidence (Elena)

Audit log filtered by period -> export -> retest records proving verification -> report
archive -> retention settings.

## 7. Administrative flows

**Team:** invite (email + role) -> accept via token -> membership created -> role changes
audited -> removal revokes sessions immediately.

**Billing:** view plan and usage -> upgrade via Stripe Checkout -> webhook updates
subscription -> entitlements re-projected -> new limits effective immediately.

**API access:** create key with scoped permissions -> **shown once** -> used in CI ->
usage visible -> rotate or revoke -> revocation effective on next request.

**Integrations:** connect via OAuth -> configure mapping (which findings, which project) ->
test delivery -> monitor delivery log -> disconnect.

## 8. Failure paths that must be designed, not discovered

Every one of these has a defined UI state; none may surface a raw error or a dead end.

| Situation | Behaviour |
|---|---|
| Asset ownership verification fails | Show what we looked for, what we found, and how to fix it. Offer re-check. |
| Target out of scope | Name the rule that denied it and offer to open scope settings. |
| Scan fails mid-run | Partial results retained, failure reason shown, one-click retry. |
| Scan times out | Marked `TIMED_OUT`, partial results kept, not presented as complete. |
| Quota exhausted | 402 with current usage, limit, and upgrade path — shown *before* the attempt where possible. |
| Payment fails | Banner, email, grace period, read access preserved. |
| Permission denied | Explain which permission is needed and who can grant it. |
| Session expired | Return to login and **restore the intended destination** after re-auth. |
| Organisation suspended | Explain the reason and the appeal path. |
| Realtime disconnects | Reconnect with backoff; fall back to polling; never show stale data as live. |
| Report generation fails | Retry, with the failure reason and support path. |
| Empty states everywhere | Explain what the thing is and what to do next, with the primary action inline. |
