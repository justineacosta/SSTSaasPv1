# Product and API documentation

> **Status: Structure defined. Content Not Implemented.** Pages are written alongside the
> features they describe, starting in Phase 3. This file defines the shape and the rules.

Customer-facing documentation, published at `/documentation` on the marketing site
([`../.claude/ui-ux/page-map.md`](../.claude/ui-ux/page-map.md)). Distinct from
[`../.claude/`](../.claude/README.md), which is internal engineering knowledge and is never
published.

## Structure

```
docs/
├── getting-started/
│   ├── introduction.md            what Sentinel is, and what it is not
│   ├── quickstart.md              signup to first finding
│   ├── core-concepts.md           asset, scope, scan, finding, occurrence, evidence, retest
│   └── glossary.md
│
├── guides/
│   ├── organizations.md           creating, settings, switching, multi-org work
│   ├── projects.md
│   ├── assets.md                  the nine types, criticality, environment, ownership
│   ├── verifying-ownership.md     ** the page users need most — per method, with troubleshooting
│   ├── scope.md                   rules, evaluation order, why a target was denied
│   ├── scans.md                   engines, profiles, scheduling, monitoring, cancelling
│   ├── findings.md                triage, status lifecycle, severity vs risk, deduplication
│   ├── evidence.md                capture, upload, redaction, retention
│   ├── engagements.md             pentest workspace, methodology, test cases
│   ├── retests.md
│   ├── reports.md                 technical, executive, retest, branding
│   ├── teams-and-roles.md         invitations, the permission matrix, custom roles
│   ├── notifications.md
│   ├── integrations/              one page per provider
│   ├── api-keys.md
│   ├── webhooks.md                payloads, signature verification, retries
│   └── billing.md                 plans, limits, usage, upgrades, downgrades
│
├── security/
│   ├── our-security.md            how we protect customer data
│   ├── responsible-testing.md     ** what we will and will not scan, and why
│   ├── data-handling.md           classification, retention, deletion, sub-processors
│   └── vulnerability-disclosure.md
│
├── api/
│   ├── overview.md                base URL, versioning, content types
│   ├── authentication.md          API keys, scopes, rotation
│   ├── errors.md                  envelope, codes, what each means
│   ├── pagination.md              cursors, limits, sorting
│   ├── filtering.md
│   ├── rate-limits.md
│   ├── webhooks.md
│   └── reference/                 generated from OpenAPI — never hand-edited
│
└── troubleshooting/
    ├── verification-failing.md    ** highest-volume support topic
    ├── scan-failures.md
    ├── target-out-of-scope.md
    ├── missing-findings.md
    └── billing-issues.md
```

The three pages marked `**` carry disproportionate weight. Ownership verification is the one
mandatory step in onboarding and therefore the largest drop-off point and the largest support
driver. "Responsible testing" is what a prospective customer's security team reads before
approving us, and what a third party reads after receiving traffic from us — writing it well is
a commercial and an ethical requirement.

## Rules

**Document what exists.** A documented feature that does not work is worse than an undocumented
one, because the user trusts it. Every page states the plan tier required, if any.

**Explain refusals.** Wherever the product says no — out of scope, unverified asset, quota
exhausted, permission denied — the documentation explains why the control exists and how to
satisfy it. A user who understands why we require ownership verification cooperates; one who
does not looks for a way around it.

**Task-oriented, not feature-oriented.** "Scan an API you own", not "The API Security Engine".
Titles start with a verb.

**Real screenshots**, taken from the actual product, regenerated when the UI changes. Never
mockups, never illustrations of features that do not exist.

**API reference is generated** from the committed OpenAPI schema and is never hand-edited —
hand-edited reference documentation drifts from the API within one release.

**Documentation ships with the feature.** A feature merged without its user documentation is
incomplete ([`../.claude/development/pull-request-rules.md`](../.claude/development/pull-request-rules.md)).

## Voice

Second person, present tense, active voice. Sentence case headings. Short paragraphs. The fixed
product vocabulary from [`../.claude/ui-ux/design-system.md`](../.claude/ui-ux/design-system.md)
§8 — asset, scope, scan, finding, occurrence, evidence, retest, engagement, report — used
consistently and never substituted with synonyms.
