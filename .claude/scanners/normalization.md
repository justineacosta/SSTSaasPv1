# Result normalisation, verification, and risk

> **Status: Designed. Not Implemented.** Phase 5.

Between an engine emitting a raw finding and a row appearing in the findings table, four
things happen. All four are platform concerns, never engine concerns — that is what makes
findings from different engines comparable.

## 1. Normalisation

Raw finding -> canonical Finding:

- **Severity** — the engine's `severityHint` is a *suggestion*. The platform derives
  severity from the CVSS vector where one is supplied, otherwise from the check taxonomy's
  base severity, then adjusts. Engines do not get the final word, because a header check
  author's idea of "medium" and a SQL injection author's idea of "medium" are not the same.
- **Taxonomy** — `checkId` maps to a catalogue entry supplying the canonical title,
  description template, CWE, OWASP category, base severity, and remediation guidance. This
  is why two engines detecting missing HSTS produce identically-worded findings.
- **Location** — canonicalised as in
  [`finding-deduplication.md`](finding-deduplication.md) §2.
- **Text** — descriptions and remediation come from the catalogue with engine-supplied
  values interpolated into named slots. **Engine text is never rendered as markup**; it is
  attacker-influenced data.
- **References** — CWE, OWASP, CVE, and vendor links from the catalogue, plus validated
  engine-supplied URLs.

## 2. Verification

Purpose: keep the triage queue trustworthy by not asserting things we have not confirmed.

| Engine confidence | Action |
|---|---|
| `HIGH` | Accept. The engine proved it (header absent, certificate expired, marker reflected). |
| `MEDIUM` | Re-probe once. Confirmed -> `HIGH`. Not confirmed -> retain as `MEDIUM`, flagged for triage. |
| `LOW` | Retain but **suppress from default views and notifications**. Visible under "low confidence". |

Re-probing is cheap, bounded, and uses the same guarded client and constraints. A finding
that cannot be reproduced at all is dropped and recorded in the scan log — the scan reports
what it discarded and why, so a suppressed true positive is discoverable rather than
invisible.

## 3. Risk scoring

Severity answers "how bad is this class of issue". Risk answers "how much should *this
organisation* care about *this instance*". Two different questions, two different numbers,
both shown.

```
risk = base(severity)
     x assetCriticality      CRITICAL 1.5 | HIGH 1.25 | MEDIUM 1.0 | LOW 0.75
     x environment           PRODUCTION 1.25 | STAGING 0.9 | DEV 0.6 | TEST 0.5
     x exposure              INTERNET_FACING 1.25 | INTERNAL 0.8
     x confidence            HIGH 1.0 | MEDIUM 0.85 | LOW 0.6
     -> clamped to 0..100
```

The inputs are always shown alongside the score. An unexplained risk number is not
actionable and invites people to ignore it. Where a CVSS vector exists it is displayed
alongside, unmodified, because that is the number customers must report externally.

Multipliers are configuration, not constants, and are per-organisation adjustable in Phase
11 — a bank and a hobby project legitimately weight environment differently.

## 4. SLA assignment

On creation, `slaDueAt = createdAt + slaDays(severity)` using the organisation's policy
(defaults: Critical 7d, High 30d, Medium 90d, Low 180d, Info none). Breaches are surfaced on
the dashboard, drive notifications, and are swept by the scheduler rather than computed on
read. Changing severity recalculates the SLA and records the change on the finding's
activity timeline.

## 5. Ordering guarantees

Normalisation is idempotent: replaying the same raw finding produces the same canonical
finding and the same fingerprint. This matters because job retries happen, and a retry must
not double-count occurrences. Occurrences carry the `scanId` and a unique constraint on
`(findingId, scanId, rawIndex)` so a replayed job converges rather than duplicating.
