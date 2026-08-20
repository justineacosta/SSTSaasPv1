# Backups

> **Status: Designed. Not Implemented.** Phase 11.
> Recovery procedures: [`disaster-recovery.md`](disaster-recovery.md).

## 1. Objectives

| Metric | Target |
|---|---|
| **RPO** (maximum acceptable data loss) | 5 minutes |
| **RTO** (maximum acceptable downtime) | 4 hours |

These drive the design: 5-minute RPO requires continuous WAL archiving, not nightly dumps. A
nightly dump has an RPO of up to 24 hours, which for a platform holding customers' security
evidence and remediation history is not defensible.

## 2. Database

| Layer | Frequency | Retention |
|---|---|---|
| Automated managed snapshots | Daily | 35 days |
| Continuous WAL archiving (PITR) | Continuous | 35 days |
| Logical `pg_dump` to separate storage | Weekly | 90 days |
| Monthly archive, separate cloud account | Monthly | 12 months |

Point-in-time recovery to any moment within 35 days. The logical dumps exist because snapshots
are tied to the provider and the engine version — a logical dump can be restored anywhere, which
matters if the failure is the provider rather than the data.

**Backups live in a separate cloud account** with write-once retention and an IAM boundary that
production credentials cannot cross. A compromise of production must not be able to delete the
backups, which is exactly what ransomware attempts first.

## 3. Object storage

Versioning enabled on every bucket, so an overwrite or delete is recoverable. Lifecycle rules
move old versions to cold storage before expiry. Cross-region replication for the `backups`
bucket; single-region with versioning for evidence and reports, on the grounds that regional
loss of evidence is recoverable from the database's record of what should exist, and the cost
difference at volume is significant.

Deletion protection on production buckets. MFA-delete on `backups`.

## 4. What is not backed up, and why that is fine

**Redis** — deliberately. Queue state and cache are reconstructible: the database is the source
of truth for every scan, and the scheduler re-enqueues anything stuck in `QUEUED`
([`../architecture/queues.md`](../architecture/queues.md) §6). Backing up a cache creates a
temptation to restore stale state.

**Engine containers** — ephemeral by design.

**Generated reports** — recorded in object storage and backed up there; regenerable from the
database if lost, though regeneration produces a new version with a new hash rather than
reproducing the original byte-for-byte, which is why they are stored rather than only
regenerated.

## 5. Verification

**A backup that has never been restored is not a backup.** It is an assumption.

| Check | Frequency | Owner |
|---|---|---|
| Automated restore to a scratch environment, with integrity queries | Weekly | Automated |
| Full restore drill, timed against RTO | Quarterly | On-call engineer |
| Cross-account restore (simulating account compromise) | Annually | Security |
| Backup job success/failure alert | Every run | Automated |

The weekly automated restore is the important one. It runs a real restore, executes a fixed set
of integrity queries (row counts per tenant table, referential integrity checks, a sample
finding with its occurrences and evidence metadata), and alerts on any deviation. A silent
backup failure discovered during an incident is the standard way this goes wrong.

The quarterly drill is timed, and the time is recorded. If it exceeds the 4-hour RTO, either the
process improves or the RTO is revised to the truth — an RTO nobody can hit is a number in a
document, not a commitment.

## 6. Retention and deletion

Backup retention interacts with customer data deletion. A customer exercising a right to erasure
cannot have their data removed from immutable backups immediately; the documented position is
that backups expire on the stated schedule and erasure is applied to live systems immediately
and to backups by expiry. This is stated in the privacy policy rather than glossed over, because
claiming otherwise would be untrue.

Legal hold suspends expiry for the affected data and is recorded.

## 7. Encryption

Backups are encrypted at rest with keys managed separately from the production application key,
and the key material is itself escrowed. A backup we cannot decrypt is not a backup either —
key recovery is part of the quarterly drill.
