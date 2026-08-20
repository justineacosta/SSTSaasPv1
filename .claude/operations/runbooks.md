# Runbooks

> **Status: Designed. Not Implemented.** Written as each alert is created; every alert must
> have one before it is allowed to page anyone.

Each runbook: symptom, likely causes, diagnosis, resolution, escalation. Written to be followed
at 3am by someone who did not build the system.

---

## Scan executed against an unverified or out-of-scope target — **SEV1**

**Symptom:** alert on an audit event showing execution where scope evaluation should have
refused.

**This is a SEV1 equal to a data breach.** The harm lands on a third party who never agreed to
anything. Do not treat it as a bug to triage in the morning.

**Immediate:**
1. Kill the scan and every running scan for that organisation.
2. Suspend the organisation.
3. Preserve the full audit trail, the scope version, and the worker logs **before** anything is
   cleaned up.

**Diagnose:** Did the API check pass wrongly, or was the worker check skipped? Was the asset
verified at enqueue and unverified at execution? Was the deny list bypassed? Was this a control
failure or a verification bypass by the customer?

**Resolve:** Fix the control. Add the case to the scope test suite so it cannot recur.
Identify and proactively contact the target owner with full detail. Involve legal.
Follow [`../security/incident-response.md`](../security/incident-response.md) §3.

**Escalate:** Security lead and legal, immediately.

---

## Cross-tenant data exposure — **SEV1**

**Immediate:** disable the affected endpoint by feature flag. Do not wait for a fix.

**Diagnose:** which query path lacked tenant scoping? Determine actual exposure from access and
audit logs — who saw what, and when. Do not estimate; count.

**Resolve:** fix; add the missing case to the isolation resource registry
([`../development/testing.md`](../development/testing.md) §3); notify every affected tenant with
what was exposed and to whom.

---

## Queue backing up

**Symptom:** oldest-job age > 30 min, or depth climbing.

**Diagnose:** `/health/detailed` for worker heartbeats. Are workers running? Are they crashing
in a loop? Is one organisation consuming all concurrency slots? Is a single engine hanging? Is
Redis healthy?

**Resolve:** scale workers if it is genuine load; restart crash-looping workers after capturing
logs; if one tenant is saturating the queue, their per-org cap is misconfigured or the fair
scheduler has a bug — cap them manually and fix it properly afterwards; if an engine hangs,
disable it by feature flag and let the timeout drain the rest.

---

## Scans stuck in RUNNING

**Diagnose:** worker died mid-job, or a container was orphaned. Check heartbeats and the
container reaper's logs.

**Resolve:** the scheduler's stuck-scan sweep marks them `FAILED` past timeout plus grace. If it
is not running, run it manually. Verify no orphaned containers remain — an orphan is still
sending traffic to a customer's system.

---

## Elevated 5xx

**Diagnose:** Sentry for the dominant exception. Check the deploy timeline — did this start at a
release? Check database connection pool saturation and Redis health.

**Resolve:** if it correlates with a deploy, **roll back first and diagnose afterwards**.
Rollback is safe by design ([`deployment.md`](deployment.md) §4).

---

## Database connections exhausted

**Diagnose:** `pg_stat_activity` for connection count by state. Idle-in-transaction connections
indicate a transaction left open in code. Did instance count just increase?

**Resolve:** kill idle-in-transaction sessions older than a threshold. Reduce pool size per
instance or add a pooler. Find and fix the unclosed transaction — this is almost always a
missing `await` or an early return inside a transaction block.

---

## Spike in failed logins

**Diagnose:** credential stuffing, or a broken client? Check IP distribution and target account
distribution. Many IPs against one account is targeted; one IP against many accounts is a sweep.

**Resolve:** rate limits should absorb it. Enable the CAPTCHA flag if not. Block egregious
sources at Cloudflare. Notify targeted account owners. Never disable the rate limiter to
"reduce noise".

---

## Spike in scope denials

**This is the primary abuse signal**, not a nuisance metric.

**Diagnose:** one organisation or many? A legitimate customer mistyping repeatedly looks like a
handful of denials against similar hostnames. Systematic probing looks like many distinct
targets across unrelated ranges.

**Resolve:** if it looks like probing, restrict the organisation and review manually. Contact
the customer. Escalate to security. See
[`../security/abuse-prevention.md`](../security/abuse-prevention.md) §4.

---

## Stripe webhooks failing

**Diagnose:** signature failures (wrong secret after rotation?), or handler errors? Check the
Stripe dashboard's delivery log against ours.

**Resolve:** fix and replay from the Stripe dashboard — handlers are idempotent on event ID, so
replay is safe. **Never manually edit subscription state to match**; re-project from Stripe,
which is authoritative ([`../architecture/billing.md`](../architecture/billing.md) §1).

---

## Storage unavailable

**Impact:** evidence upload fails, so scans fail rather than recording findings with missing
evidence — deliberate ([`../architecture/workers.md`](../architecture/workers.md) §6).

**Resolve:** check provider status and credentials. Scans that failed for this reason are safe
to re-run once storage returns.

---

## Certificate expiring

Cloudflare renews automatically. If the alert fires, renewal is failing — check DNS validation
records. Never let this reach expiry; a security product serving an expired certificate is
worse than an outage.
