# Secrets management

> **Status: Designed. Not Implemented.** Phase 1 for sourcing and validation; managed KMS
> in Phase 11.

## 1. Rules

1. **No secret in source control, ever.** Not in code, config, tests, fixtures, seeds,
   comments, or documentation. `.env.example` holds placeholders only.
2. Secrets come from the environment, populated by a secrets manager in deployed
   environments (AWS Secrets Manager / Vault / Doppler) — never from a committed file.
3. **Environments never share secrets.** Development cannot hold a production credential.
4. Every secret is rotatable without a code change, and rotation is exercised, not assumed.
5. Secrets are validated at boot by a Zod schema. A missing or malformed secret **crashes
   startup** — a service must never run half-configured and fail mysteriously later.

## 2. Inventory

| Secret | Held by | Rotation |
|---|---|---|
| `DATABASE_URL` | api, worker, scheduler | 90d |
| `REDIS_URL` | api, worker, scheduler | 90d |
| `SESSION_SECRET` | api | 90d (rolling: accept previous during overlap) |
| `ENCRYPTION_KEY` | api, worker | Versioned; see §3 |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | api, worker | 90d |
| `STRIPE_SECRET_KEY` | api | On demand |
| `STRIPE_WEBHOOK_SECRET` | api | On demand |
| `RESEND_API_KEY` | api, scheduler | 90d |
| `SENTRY_DSN` | all | Low sensitivity |
| OAuth client secrets (GitHub, GitLab, Jira, Slack) | api | Per provider |

**Engine containers receive none of these.** They receive a target and a config.

## 3. Encryption at rest

Application-level encryption for the fields that would be catastrophic in a database dump,
on top of volume encryption: MFA seeds, integration OAuth tokens, webhook signing secrets,
and stored scan credentials (when a customer supplies authenticated-scan credentials).

AES-256-GCM with a **key ID stored alongside the ciphertext**, so keys can be rotated and
old data decrypted with the previous key while new writes use the new one. Rotation is a
background re-encryption job, not a migration outage.

Hashing, not encryption, for anything we never need to read back: passwords (Argon2id),
session tokens, API keys, invitation and reset tokens (SHA-256, since they are already
high-entropy random values).

## 4. Handling in code

- One typed config module per app. **No `process.env` access outside it** — enforced by
  lint rule.
- Secrets are never interpolated into logs, error messages, traces, or spans. The logger
  redacts by key name and by value-shape heuristics as a backstop.
- Secrets are not passed as command-line arguments (visible in the process table); use
  environment or a file descriptor.
- API keys and webhook secrets are shown **once** at creation and never retrievable again.
  The UI says so plainly before generation.

## 5. Leak response

Treat as an incident ([`incident-response.md`](incident-response.md)): revoke first, then
investigate. Rotate the secret, invalidate everything derived from it, audit for use during
the exposure window, purge from history if committed (and rotate anyway — assume it was
scraped), and record the cause. Secret scanning runs in CI and as a pre-commit hook so the
common case is caught before it lands.
