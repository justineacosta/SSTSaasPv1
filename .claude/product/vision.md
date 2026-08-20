# Product vision

## The problem

Security testing is fragmented across tools that do not share a spine. Scanners produce
findings in incompatible formats. Pentest reports arrive as PDFs that nobody can query.
Vulnerability management lives in a spreadsheet or a Jira project that drifts out of date
within a week. Retesting means emailing a consultant. Nobody can answer "what is our actual
security posture, right now, across everything we own?" without a week of manual assembly.

The gap is not detection. Detection is a commodity. The gap is that **findings from
automated tools and findings from human testers do not live in the same system with the
same lifecycle**, so neither can be tracked, deduplicated, retested, or reported on
coherently.

## The product

Sentinel is the system of record for an organisation's security testing.

Automated scans and manual penetration testing produce findings into **one** normalised
model, against **one** verified asset inventory, with **one** lifecycle, **one** risk
model, and **one** reporting layer. A finding raised by a scanner and a finding raised by a
consultant are the same kind of object, tracked the same way, retested the same way, and
reported the same way.

## Who it is for

Consultancies delivering pentests, in-house security teams running continuous testing,
engineering teams that need findings to arrive where they work, and compliance functions
that need evidence and history. Detail: [`personas.md`](personas.md).

## What makes it defensible

1. **Automated and manual in one lifecycle.** Most competitors do one well and bolt the
   other on. The finding model, deduplication, and retest flow are designed for both from
   the start.
2. **Deduplication that actually works.** Deterministic fingerprints with occurrence
   history mean a weekly scan does not produce a weekly copy of the same finding. This is
   the difference between a tool people use and a tool people mute.
3. **Verified asset inventory as the foundation.** Ownership verification is a safety
   control, but it is also the thing that makes the asset inventory trustworthy enough to
   report against.
4. **Evidence as a first-class object.** Screenshots, requests, and responses attached to
   findings, retained, redacted, access-controlled, and audited — which is what makes the
   output usable in a compliance context rather than just an engineering one.
5. **An extensible engine contract.** New testing capability is a plugin, not a rewrite.

## Principles

**Real results only.** No fabricated data anywhere, including demos. If we cannot verify a
finding, we mark it low-confidence rather than presenting it as fact. A security product
that lies about its own output has no reason to exist.

**Safe by default.** The default profile is non-destructive. Nothing runs against a target
we have not verified the customer owns.

**The boring parts are the product.** Triage, deduplication, assignment, retest, and
reporting are where security teams actually spend their time. Scanning is the easy half.

**Findings must land where work happens.** A finding that requires logging into another
tool to see is a finding that will not get fixed.

## Non-goals

We are not building a SIEM, an EDR, a WAF, a compliance-questionnaire tool, or a bug
bounty platform. We are not competing on raw scanner breadth against decades-old
vulnerability scanners; we compete on the lifecycle around the findings.

## Success signals

Time from finding discovered to finding assigned. Percentage of findings retested rather
than closed on assertion. Duplicate rate across repeat scans (target: near zero). Reports
generated per engagement. Assets verified as a share of assets registered. Ultimately:
whether a customer's mean time to remediate falls after adopting the product.
