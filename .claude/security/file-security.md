# File and evidence security

> **Status: Designed. Not Implemented.** Phase 5.

Files here are unusually dangerous: much of our evidence is *captured from hostile targets*
and is attacker-controlled by construction.

## 1. Upload validation

Applied in order; any failure rejects:

1. **Size** — per-type cap enforced while streaming, not after buffering. Storage
   entitlement checked before accepting.
2. **Declared type** against an allowlist. Extensions are a hint, never a decision.
3. **Content sniffing** — magic-byte detection; mismatch with the declared type rejects.
4. **Structural validation** per type — images decoded and re-encoded (stripping EXIF and
   any embedded payload), JSON parsed with depth and size limits, archives inspected for
   path traversal and expansion ratio.
5. **Filename** — never trusted, never used as a storage key. Original name is stored as
   metadata for display; the key is generated.
6. **Malware scan** where enabled (ClamAV in the pipeline); quarantine on hit.

Never accepted: executables, scripts, HTML, SVG (an XSS vector), or anything the browser
would interpret as active content.

## 2. Storage

- S3-compatible, **buckets never public**, TLS enforced, SSE at rest.
- Key: `org/{organizationId}/{resourceType}/{resourceId}/{uuid}` — the org prefix means a
  leaked key cannot address another tenant, and the UUID means keys are unguessable.
- Immutable: no overwrite, versioning on, lifecycle rules per retention policy.
- SHA-256 recorded at upload for integrity verification and for evidence chain-of-custody.

## 3. Access control

Every access is authorised server-side — including presigned URL issuance, which is where
this is usually got wrong.

```
GET /evidence/:id/download
  -> authenticate, resolve tenant
  -> load evidence via tenant-scoped client (cross-tenant -> 404)
  -> authorize evidence.read
  -> write EVIDENCE_ACCESSED audit event
  -> mint presigned GET, 5 min TTL, response-content-disposition=attachment
  -> 302
```

Presigned URLs are short-lived, single-purpose, and never returned in list responses —
only on explicit request, so that a bulk listing does not hand out a hundred live URLs.

## 4. Serving safely

- Always `Content-Disposition: attachment` with a sanitised filename, and
  `X-Content-Type-Options: nosniff`.
- Served from a **separate origin** from the application, so that even a successful content
  injection lands in a different origin with no access to session cookies or the app DOM.
- Previews render inside a sandboxed `iframe` with a restrictive CSP; images are re-encoded
  server-side. **Evidence is never injected into the application DOM as markup.**
- HTTP request/response evidence is displayed as escaped, syntax-highlighted **text**.

## 5. Redaction

Evidence frequently contains secrets belonging to the *customer* — session cookies,
`Authorization` headers, API keys in query strings, PII in bodies. Automatic redaction runs
on capture for known-sensitive headers and common token patterns, storing both the redacted
form and, where the organisation's policy allows, the original under stricter permission.
Users can redact further manually; redaction is audited and irreversible where policy
requires.

## 6. Retention and deletion

Retention is per organisation and per plan. Deletion removes the object, the metadata row,
and any derived thumbnails, and writes an audit event. Legal-hold blocks deletion. Deletion
is asynchronous and verified, not fire-and-forget — an orphan sweep reconciles storage
against the database on a schedule in both directions.

## 7. Testing requirements

Oversized upload rejected while streaming; content/extension mismatch rejected; SVG and
HTML rejected; polyglot file rejected; zip bomb rejected; path-traversal filename
neutralised; cross-tenant download returns 404; presigned URL expires; presigned URL for
tenant A's key cannot be minted from tenant B's session; access writes an audit event;
evidence containing `<script>` renders as text and does not execute.
