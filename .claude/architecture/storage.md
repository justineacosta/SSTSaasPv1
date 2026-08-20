# Storage architecture

> **Status: Adapter Implemented (Phase 1).** Evidence (Phase 5) and reports (Phase 8) are not yet
> built — nothing calls this adapter in application code. Decision record:
> [ADR-0007](../decisions/ADR-0007-evidence-storage.md).

S3-compatible object storage. MinIO locally, Cloudflare R2 or AWS S3 in production, behind
one adapter interface so the provider is a configuration choice rather than a code
dependency.

## 1. Buckets

| Bucket | Contents | Lifecycle |
|---|---|---|
| `evidence` | Scan and manual evidence artifacts | Per-org `dataRetentionDays` |
| `reports` | Generated PDF/HTML/JSON reports | Per-org retention |
| `uploads` | User uploads before processing | 24 h, then deleted or promoted |
| `exports` | CSV/JSON exports | 7 days |
| `backups` | Database dumps | Per backup policy, immutable |

All private. Versioning on. Server-side encryption on. Public access blocked at the account
level, not just the bucket level.

## 2. Key structure

```
evidence/org/{organizationId}/finding/{findingId}/{uuid}.{ext}
evidence/org/{organizationId}/scan/{scanId}/{uuid}.{ext}
reports/org/{organizationId}/{reportId}/{uuid}.pdf
```

The organisation prefix is the point: a leaked or guessed key cannot address another
tenant's object, and prefix-scoped IAM policies become possible. The UUID means keys are not
enumerable. **Original filenames are never used in keys** — they are stored as metadata for
display only.

## 3. Access

Never public, never direct. Every read goes through the API, which resolves the object via
the tenant-scoped client, authorises, audits, and then mints a short-lived presigned URL
(5 min, single purpose, `Content-Disposition: attachment`). Uploads use presigned PUT URLs
issued only after validation of the declared type and size against entitlements, with the
object verified server-side after upload before its metadata row is marked ready.

Full rules: [`../security/file-security.md`](../security/file-security.md).

## 4. Adapter

Implemented in `packages/storage` (not `apps/api/src/infrastructure` — see
[`../development/folder-structure.md`](../development/folder-structure.md) Rules: workers need
it from Phase 5, and no app may import another app).

```ts
interface StorageAdapter {
  put(bucket, key, body, opts?): Promise<{ etag, size, sha256 }>
  get(bucket, key): Promise<Readable>
  head(bucket, key): Promise<StoredObjectMetadata | null>
  delete(bucket, key): Promise<void>
  presignGet(bucket, key, opts): Promise<string>   // opts: { ttlSeconds, downloadFilename? }
  presignPut(bucket, key, ttlSeconds): Promise<string>
  list(bucket, prefix, cursor?): Promise<KeyPage>
}
```

Every method takes the bucket explicitly — the adapter is provider configuration, not a
per-bucket client, so one adapter instance serves `evidence`, `reports`, `uploads`, and
`exports`. `createS3StorageAdapter(options: S3StorageOptions)` is the only S3-backed
implementation; `options` (`endpoint`, `region`, `accessKeyId`, `secretAccessKey`,
`forcePathStyle`) are plain strings/booleans — no AWS SDK type crosses into `S3StorageOptions`
or the `StorageAdapter` interface itself, so application code never imports an S3 SDK type.

`tenantPrefix`, `evidenceKeyForFinding`, `evidenceKeyForScan`, and `reportKey` (also in
`packages/storage`) are the only way to build a key: `tenantPrefix` throws rather than
returning a prefix-less key for an empty organisation id, and every builder routes through it.

Tests run against MinIO in Testcontainers, not against mocks, because the failure modes that
matter here — content type handling, presign semantics, multipart, eventual consistency — are
exactly the ones a mock hides.

## 5. Integrity and reconciliation

SHA-256 computed at upload, stored in the metadata row, and verified on download for evidence
where chain of custody matters. A weekly reconciliation job compares storage against the
database **in both directions**: objects without metadata rows are orphans to be cleaned;
metadata rows without objects are a data-loss incident and alert immediately.

## 6. Report generation

Reports are generated in a worker, never in a request. HTML from templates, PDF via headless
Chromium in a capped container. The generated file is uploaded, hashed, and recorded
immutably — a report, once generated, is never regenerated in place, because customers cite
report contents in contracts and audits. Regeneration produces a new version with its own ID
and hash.

## 7. Cost and durability

Lifecycle rules move old evidence to infrequent-access tiers before expiry. Large artifacts
are compressed at rest. Uploads over 5 MiB use multipart. Storage consumption is metered per
organisation against `maxStorageBytes` and is enforced at upload time rather than discovered
at invoice time. Cross-region replication for `backups`; single-region with versioning for
the rest.
