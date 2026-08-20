# Incident response

> **Status: Designed. Not Implemented.** Contacts, on-call, and the first tabletop
> exercise are prerequisites for production launch.

## 1. Severity

| Sev | Definition | Response | Comms |
|---|---|---|---|
| **SEV1** | Cross-tenant data exposure; platform compromise; scanning an unauthorised third party; credential compromise | Immediate, all hands | Customer + regulator notification assessed within hours |
| **SEV2** | Single-tenant data exposure; auth bypass; evidence leak; billing integrity failure | < 1 hour | Affected customers |
| **SEV3** | Degraded security control; DoS; worker compromise contained | < 4 hours | Status page |
| **SEV4** | Low-impact vulnerability, no exploitation | Next business day | Internal |

Scanning a target we were not authorised to scan is a **SEV1**, equal to a breach, because
the harm lands on a third party who never agreed to anything.

## 2. Phases

**Detect** — Sentry alerts, anomaly detection on scope denials and scan volume, failed-auth
spikes, queue anomalies, customer reports, and the `security@` inbox. A documented
vulnerability disclosure policy with a published contact is a launch requirement.

**Triage** — assign severity and an incident commander; open a channel and a timeline
document; the commander coordinates and does not fix.

**Contain** — the point is to stop harm, not to preserve tidiness:
suspend the offending organisation; kill running scans and revoke worker credentials;
revoke sessions/keys; disable the affected feature by flag; block at the edge. Capture
forensic state (audit log extract, container state, logs) **before** destroying evidence.

**Eradicate and recover** — fix the cause, rotate anything possibly exposed, restore from
verified backups if integrity is in doubt, verify the control now works, restore service.

**Review** — blameless post-mortem within five business days: timeline, root cause,
detection gap, containment effectiveness, action items with owners and dates. Publish
externally when customers were affected.

## 3. Specific playbooks

**Cross-tenant exposure** — identify the query path; determine scope from audit and access
logs; disable the endpoint; fix; add the missing case to the isolation test matrix so it
cannot recur; notify every affected tenant with what was exposed and to whom.

**Unauthorised target scanned** — stop all scans for that organisation immediately; identify
the target owner and contact them proactively with full detail; preserve the complete audit
trail including the scope evaluation; determine whether it was a control failure or an
ownership-verification bypass; suspend the customer pending review; involve legal.

**Credential or key compromise** — revoke first, investigate second. Rotate, invalidate
derived material, audit use during the exposure window, notify.

**Engine container escape** — assume the worker host is compromised; isolate the host,
destroy it rather than clean it, rotate every credential the host could reach, review egress
logs for lateral movement, rebuild from a known-good image.

**Ransomware or destructive action** — isolate; restore from immutable backups; confirm
backup integrity before restoring; do not pay.

## 4. Communications

Internal channel and timeline from minute one. Status page for anything customer-visible.
Customer notification for SEV1/SEV2 states what happened, what data was involved, what we
did, and what they should do — no minimisation. Regulatory clocks (GDPR: 72 hours) start at
awareness, and the assessment is documented even when the conclusion is "not notifiable".

## 5. Preparation checklist (pre-launch)

- [ ] `security@` and `abuse@` monitored, with SLAs
- [ ] Published vulnerability disclosure policy
- [ ] On-call rotation and escalation path
- [ ] Incident channel and timeline template
- [ ] Break-glass credentials in escrow, tested
- [ ] Backup restore drill completed and timed
- [ ] Organisation suspension tested end to end
- [ ] Legal and regulatory contacts identified
- [ ] One tabletop exercise run per major playbook
