# Disaster recovery

> **Status: Designed. Not Implemented.** Phase 11. The first full drill is a prerequisite for
> production launch. Backup design: [`backups.md`](backups.md).

**RPO 5 minutes. RTO 4 hours.** Every procedure below is written to meet those, and the
quarterly drill measures whether it actually does.

## 1. Scenarios and responses

| Scenario | Impact | Response | Target |
|---|---|---|---|
| Application instance failure | None (autoscaling replaces) | Automatic | — |
| Availability zone failure | Brief degradation | Managed failover | < 5 min |
| Database primary failure | Writes unavailable | Managed HA failover | < 5 min |
| Database corruption | Data integrity | PITR to just before corruption | < 4 h |
| Accidental destructive migration | Data loss | PITR + roll-forward correction | < 4 h |
| Redis loss | Queue position lost, cache cold | Rebuild; scheduler re-enqueues stuck scans | < 30 min |
| Object storage loss (single region) | Evidence unavailable | Restore from replication/versions | < 4 h |
| Region failure | Full outage | Restore into secondary region | < 4 h |
| Cloud account compromise | Total | Rebuild from cross-account backups | < 24 h |
| Ransomware | Total | Restore from immutable, write-once backups | < 24 h |

The last two are why backups live in a separate account with write-once retention that
production credentials cannot reach ([`backups.md`](backups.md) §2).

## 2. Database recovery

```
1. Stop application writes: scale API to zero, pause workers.
2. Identify the target timestamp — the last known-good moment.
3. Restore via PITR to a NEW instance. Never restore over the primary;
   the damaged primary is evidence, and you may need it.
4. Verify: row counts per tenant table, referential integrity, a sampled
   finding with its occurrences and evidence metadata, recent audit events.
5. Repoint the application at the restored instance.
6. Scale up. Verify health. Resume workers.
7. Reconcile object storage against the restored database — evidence rows
   may reference objects written after the restore point, or vice versa.
8. Write the timeline.
```

Step 7 is the one people forget. The database and object storage recover to different points,
so after any PITR the reconciliation job must run: metadata rows without objects are flagged as
data loss and the affected customers notified; objects without rows are orphans to be cleaned.

## 3. Redis recovery

Redis is not backed up, deliberately. Recovery is: provision a new instance, restart workers,
and let the scheduler re-enqueue anything stuck in `QUEUED` past its threshold. Rate limit
counters and cache rebuild naturally.

The one visible effect is that scans in flight at the moment of loss are reclaimed and
re-validated from scratch, which is the correct behaviour — a scan resumed from a stale queue
payload would skip the re-validation that protects third parties.

## 4. Region failure

The secondary region holds replicated backups and infrastructure definitions, not warm
capacity — a hot standby for a product at this stage is a cost that buys minutes we have not
committed to. Recovery: provision from Terraform in the secondary region, restore the database
from the most recent cross-region backup, repoint DNS through Cloudflare, verify, and announce.

This is the scenario most likely to exceed RTO. It is stated honestly here rather than
optimistically, and the quarterly drill includes it annually.

## 5. Data integrity verification

After any restore, before declaring recovery:

- [ ] Row counts per tenant table within expected bounds
- [ ] No orphaned foreign keys
- [ ] Every organisation has at least one `OWNER`
- [ ] Audit log continuity — no unexplained gap
- [ ] Evidence metadata reconciles against object storage in both directions
- [ ] Subscription state reconciles against Stripe (Stripe is authoritative; re-project
      entitlements from it rather than trusting the restored projection)
- [ ] A sample of findings render correctly with their occurrences and evidence
- [ ] Scans stuck in `RUNNING` are swept to `FAILED` rather than left hanging

The Stripe reconciliation matters: restoring the database to an earlier point restores an
earlier billing projection, and a customer who upgraded in the interim would silently lose
their entitlements. Re-projecting from Stripe fixes it.

## 6. Communication

Status page updated within 15 minutes of a confirmed incident, then at least hourly. Customer
notification for anything involving data loss, stating what was lost and for what period —
never minimised. A post-mortem published within five business days when customers were
affected. See [`../security/incident-response.md`](../security/incident-response.md) §4.

## 7. Drill schedule

| Drill | Frequency | Recorded |
|---|---|---|
| Automated restore + integrity queries | Weekly | Pass/fail, alerted |
| Full timed restore against RTO | Quarterly | Elapsed time vs 4h target |
| Region failover | Annually | Elapsed time, gaps found |
| Cross-account restore | Annually | Key recovery included |
| Tabletop per incident playbook | Annually | Action items |

**Every drill produces action items or it was not a real drill.** A drill that passes perfectly
every time is usually a drill that is testing the easy path.
