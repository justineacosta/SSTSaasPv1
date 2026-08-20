# ADR-0007 — Evidence in S3-compatible storage, metadata in Postgres

**Status:** Accepted · **Date:** 2026-08-20

## Context

Evidence — screenshots, HTTP request/response captures, scanner artifacts, tester uploads — is
what makes a finding believable and is a large fraction of the platform's data volume. It is
also unusually dangerous content: much of it is captured from hostile targets and is therefore
attacker-controlled by construction, and it frequently contains the *customer's* secrets
(session cookies, bearer tokens, PII).

## Decision

**Bytes in S3-compatible object storage; metadata in Postgres.** MinIO locally, Cloudflare R2 or
AWS S3 in production, behind a single `StorageAdapter` interface so the provider is
configuration rather than a code dependency.

Four properties are non-negotiable:

1. **Keys are prefixed `org/{organizationId}/…` with a UUID filename.** A leaked or guessed key
   cannot address another tenant's object, and keys are not enumerable. Original filenames are
   metadata for display only, never part of a key.
2. **Buckets are never public.** Every read goes through the API, which authorises via the
   tenant-scoped client, writes an `EVIDENCE_ACCESSED` audit event, then mints a 5-minute
   presigned URL. **Authorisation happens before signing**, which is where this is usually got
   wrong.
3. **Evidence is served from a separate origin** and always as an attachment, so a successful
   content injection lands in an origin with no access to session cookies or the application
   DOM.
4. **Evidence is never rendered as markup.** Escaped text, re-encoded images, or a sandboxed
   frame with a restrictive CSP.

Small inline content (< 64 KiB of request/response text) is stored in Postgres directly to avoid
an object round trip for the common case.

## Alternatives considered

**Everything in Postgres as `bytea`.** Rejected. Bloats the database, slows backups and
restores, wastes the buffer cache on data that is read rarely, and makes PITR far more
expensive. Object storage is an order of magnitude cheaper for this volume.

**Everything in object storage including small text.** Rejected as an unnecessary round trip
for the most common evidence type. The 64 KiB threshold is a pragmatic split.

**Public bucket with unguessable URLs.** Rejected firmly. This is security by obscurity, it
produces no access audit trail, URLs leak through referrers and logs and browser history, and
access cannot be revoked. For evidence containing customers' live session tokens, unacceptable.

**Long-lived presigned URLs cached in list responses.** Rejected. A list response would hand out
a hundred live URLs at once, none of which can be revoked. URLs are minted on explicit request
only.

## Consequences

**Positive.** Cheap, durable, scalable storage. Database stays small and fast to back up. Every
access is authorised and audited. Tenant prefixes enable prefix-scoped IAM. Provider is
swappable. Separate serving origin contains injection.

**Negative.** Two systems that can diverge — mitigated by a SHA-256 recorded at upload and a
weekly reconciliation job comparing storage against the database **in both directions**;
metadata without an object is a data-loss alert, not a cleanup task. Presigning adds a request
hop. A restore after PITR recovers database and storage to different points, which is why
reconciliation is an explicit step in
[`../operations/disaster-recovery.md`](../operations/disaster-recovery.md) §2.

**Neutral.** Retention is enforced per organisation entitlement by the scheduler, deleting the
object and the row together, with legal hold blocking expiry.
