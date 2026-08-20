# Evidence

> **Status: Designed. Not Implemented.** Phase 5.
> Security: [`../security/file-security.md`](../security/file-security.md).

Evidence is what makes a finding believable. A finding without evidence is an opinion, and
engineers correctly refuse to act on opinions.

## 1. Types

| Type | Source | Storage |
|---|---|---|
| `HTTP_REQUEST` / `HTTP_RESPONSE` | Engine capture | Inline if < 64 KiB, else object storage |
| `SCREENSHOT` | Headless browser | Object storage, PNG, re-encoded |
| `LOG` | Engine stderr, scan log excerpt | Object storage |
| `JSON` / `TEXT` | Structured engine output | Inline or object storage by size |
| `FILE` | Manual upload by a tester | Object storage |
| `ARTIFACT` | Raw scanner output for reproducibility | Object storage |

## 2. Capture rules

- Captured **at the moment of detection**, not reconstructed afterwards. A finding's evidence
  must correspond to the request that actually proved it.
- Request/response pairs are stored whole, including headers, subject to size caps and
  redaction. Bodies are truncated with an explicit marker rather than silently.
- Screenshots are taken at a fixed viewport for comparability and re-encoded server-side to
  strip anything embedded in the original.
- Every artifact records a SHA-256 at capture, which is the chain-of-custody anchor that
  makes evidence usable in a compliance or dispute context.
- Evidence is attached to the **occurrence**, not only the finding, so history shows what
  each scan actually saw. The finding surfaces its most recent evidence by default.

## 3. Redaction

Scan evidence routinely contains the customer's own secrets. Automatic redaction runs at
capture on `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and common bearer/JWT/API
key patterns in bodies and query strings, replacing values with `[REDACTED:<kind>]` so the
structure remains legible.

Redaction is applied **before storage**, not before display — we do not store what we do not
need. Organisations may opt into retaining originals under a stricter permission, and that
choice is recorded and audited. Manual redaction is available and irreversible; both are
audited.

## 4. Access and display

Access flow, audit event, presigned URL policy, and the separate serving origin are covered
in [`../security/file-security.md`](../security/file-security.md). The rule that governs
everything here: **evidence is attacker-controlled data and is never rendered as markup.**
HTTP evidence displays as escaped, syntax-highlighted text with a diff view between
occurrences; screenshots display as images on the isolated origin; JSON displays through a
structural viewer, never `dangerouslySetInnerHTML`.

## 5. Retention

Evidence follows the organisation's `dataRetentionDays` entitlement. Expiry deletes the
object and the metadata row and writes an audit event; legal-hold blocks deletion. A
reconciliation job compares storage against the database in both directions and reports
orphans, because silent divergence between a file store and its index is how "we still have
the evidence" quietly becomes untrue.
