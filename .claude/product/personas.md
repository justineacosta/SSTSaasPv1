# Personas

Five personas drive every prioritisation decision. Where their needs conflict, the order
below is the tiebreaker.

## 1. Priya — Penetration testing consultant

**Role:** Senior consultant at a security consultancy, runs 2–4 engagements at once.
**Default role in product:** `SECURITY_LEAD` on client organisations.

Lives in engagements. Needs scope defined and agreed before touching anything, a methodology
checklist she can work through, somewhere to record manual findings with evidence as she
finds them, and a report that assembles itself from that record instead of costing her two
days at the end of every engagement.

**Pains:** writing the same report boilerplate repeatedly; screenshots scattered across a
desktop; retest requests arriving by email weeks later with no context; clients disputing
what was in scope.

**What she needs from us:** fast manual finding entry with keyboard-first flow, drag-and-drop
evidence, reusable methodology templates, versioned scope she can point at during a dispute,
and one-click report generation. **If report generation is not excellent, she will not use
the product** — it is the deliverable her business is paid for.

## 2. Marcus — In-house security engineer

**Role:** One of three security people covering 200 engineers.
**Default role:** `ADMIN`.

Lives in the findings queue and the dashboard. Runs continuous scans, triages, assigns, and
chases. Deeply outnumbered, so his scarcest resource is attention.

**Pains:** scanner noise; the same finding reappearing every week as a new item; no way to
tell whether a "fixed" finding is actually fixed; explaining posture to leadership with
screenshots pasted into slides.

**What he needs:** aggressive deduplication, confidence scoring so he can triage the
high-confidence set first, bulk triage actions, SLA tracking, and a dashboard that answers
"are we getting better?" without manual assembly. **Deduplication quality determines whether
he keeps using the product.**

## 3. Sofia — Engineering lead

**Role:** Backend team lead. Security is not her job, but fixing things is.
**Default role:** `MEMBER`, scoped to her projects.

Interacts with findings assigned to her team. Does not want to learn a security tool.

**Pains:** findings written for auditors rather than engineers; no reproduction steps; no
way to say "this is a false positive" and be heard; being told something is critical without
being told why.

**What she needs:** clear reproduction with real request/response evidence, actionable
remediation with code-level guidance, the ability to challenge a finding and have it
tracked, and findings arriving in Jira or Slack rather than requiring another login.

## 4. David — CISO / security leader

**Role:** Accountable for security posture; reports to the board.
**Default role:** `VIEWER` or `ADMIN`.

Rarely opens a finding. Lives in trends and executive reports.

**Pains:** cannot answer "are we more secure than last quarter?" with evidence; posture
reporting is manual; no view of coverage — which assets have never been tested at all.

**What he needs:** risk trend over time, coverage metrics, SLA compliance, remediation
velocity, and executive reports he can hand to a board without editing.

## 5. Elena — Compliance and audit lead

**Role:** Prepares for SOC 2, ISO 27001, and customer security reviews.
**Default role:** `AUDITOR`.

**Pains:** proving that testing happened, on what scope, with what result, and that findings
were remediated and verified — usually reconstructed from email months later.

**What she needs:** immutable audit trail, retained evidence, retest records proving
remediation was verified rather than asserted, exportable history, and configurable
retention. Notably, she needs to prove testing *occurred* without necessarily seeing
vulnerability detail — which is why `AUDITOR` reads the audit log but not evidence bodies.

## Priority order

**Priya and Marcus are the primary personas.** They are the daily users and the buyers'
practitioners; if the product fails them it fails entirely. Sofia determines whether
findings actually get fixed, which determines renewal. David signs the contract. Elena
determines whether the product survives the customer's own procurement review.
