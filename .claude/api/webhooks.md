# Webhooks

> **Status: Designed. Not Implemented.** Phase 9.
> Integration framework: [`../architecture/integrations.md`](../architecture/integrations.md).

Two directions, with very different risk profiles.

- **Outbound** — we deliver events to a customer-chosen URL. The customer chooses the
  destination, which makes this an SSRF surface and a data-exfiltration channel by design.
- **Inbound** — third parties (Stripe, GitHub, Jira) deliver to us. Signature verification is
  the only thing standing between a forged request and our billing state.

## 1. Outbound — endpoints

```
POST /api/v1/webhooks   { url, events[], description? }
  -> 201 { id, url, events, secret: "whsec_01J...", status: "ACTIVE" }
```

`secret` is shown **once**. Requires `webhook.create`, which is an elevated permission
precisely because an endpoint is a mechanism for routing findings out of the platform.

URL validation at creation and again at every delivery: HTTPS only, public address only, DNS
resolved and every resulting address checked against the global deny list, no redirects
followed, no credentials in the URL. The same SSRF guard that protects scanning protects
delivery ([`../security/scope-controls.md`](../security/scope-controls.md) §6).

## 2. Delivery format

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json
X-Sentinel-Event: finding.created
X-Sentinel-Delivery: dlv_01J8XK2P9V3QW
X-Sentinel-Signature: t=1756900000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
User-Agent: Sentinel-Webhooks/1.0
```

```jsonc
{ "id": "evt_01J...", "type": "finding.created", "createdAt": "2026-08-20T14:30:00Z",
  "organizationId": "org_01J...",
  "data": { "findingId": "fnd_01J...", "severity": "HIGH", "title": "Missing HSTS",
            "assetId": "ast_01J...", "projectId": "prj_01J...",
            "url": "https://app.sentinel.example/findings/fnd_01J..." } }
```

Payloads are **summaries, not full records**. They carry identifiers, a severity, a title, and
a link. They never carry evidence bodies, HTTP captures, or credentials — an endpoint URL is
often a chat integration or a log sink with far weaker access control than our own storage,
and pushing evidence into it would undo the access controls around evidence entirely. Consumers
that need detail call the API with their own credentials.

## 3. Signature verification

The signature is `HMAC-SHA256(secret, "{timestamp}.{raw_body}")`, hex-encoded. Consumers must:

1. Read the **raw** body — parsing and re-serialising changes the bytes and breaks the HMAC.
2. Recompute over `timestamp + "." + rawBody`.
3. Compare in **constant time**.
4. **Reject timestamps older than 5 minutes** — the timestamp is inside the signed material, so
   this is what makes replay detectable rather than merely unlikely.

Secrets rotate with an overlap window during which both the old and new secrets produce valid
signatures, so consumers can roll without dropping deliveries.

## 4. Retries and failure

At-least-once delivery. Success is any 2xx within 10 seconds; everything else retries with
exponential backoff and jitter across 8 attempts spanning roughly 24 hours.

Consumers **must be idempotent** on `X-Sentinel-Delivery`. A network timeout after the
consumer committed is indistinguishable from a genuine failure, so duplicates will happen.

An endpoint failing continuously for 72 hours is automatically disabled, and the organisation
is notified with the last failure reason. Delivery logs retain the request, response status,
response body excerpt, and timing, and are visible at `/webhooks/{id}` for debugging —
including a replay button.

```
POST /api/v1/webhooks/{id}/test   -> sends a signed ping to verify the endpoint
POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry
```

## 5. Events

```
scan.started   scan.completed   scan.failed   scan.cancelled
finding.created   finding.updated   finding.status_changed   finding.reopened
retest.completed
report.generated
asset.verification_expired
member.invited   member.removed   member.role_changed
subscription.updated   usage.limit_reached
```

Endpoints subscribe to specific types or to a wildcard within a domain (`finding.*`).
Events are filtered by the subscribing endpoint's organisation at dispatch, so an endpoint can
only ever receive its own tenant's events.

## 6. Inbound

`POST /api/v1/webhooks/stripe` — the most security-sensitive non-auth endpoint in the system.
Raw-body signature verification, timestamp tolerance, and event-ID idempotency, detailed in
[`../architecture/billing.md`](../architecture/billing.md) §3.

`POST /api/v1/webhooks/{provider}` for GitHub, GitLab, and Jira — each verified with that
provider's own signature scheme, each idempotent on the provider's delivery ID, each rate
limited, and each processing asynchronously after returning 200 quickly so a slow handler
cannot cause the provider to retry unnecessarily.

Inbound handlers are `@Public()` at the route level because the signature *is* the
authentication — but they are the only public mutating endpoints in the product, and each one
is individually reviewed as such.

## 7. Testing

Signature generation matches a known-good fixture; a tampered body fails; a stale timestamp is
rejected; duplicate delivery IDs are no-ops; retries follow the schedule and stop at the cap;
persistent failure disables the endpoint and notifies; delivery to a private address, a
loopback address, a metadata endpoint, or an HTTP URL is refused; a redirect is not followed;
an endpoint belonging to tenant A never receives tenant B's events; secret rotation accepts
both secrets during the overlap.
