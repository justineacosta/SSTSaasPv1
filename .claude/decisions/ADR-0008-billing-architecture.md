# ADR-0008 — Stripe as billing authority, entitlements as the local projection

**Status:** Accepted · **Date:** 2026-08-20

## Context

We need subscriptions, plan changes, usage limits, invoices, payment failure handling, and
enterprise deals with negotiated terms. Two questions must be answered separately: *what is this
organisation paying for* (a billing question) and *what may this organisation do right now* (an
authorization question asked on nearly every request).

## Decision

**Stripe is the source of truth for subscription state.** The database holds a projection,
updated by verified webhooks. The application **never calls Stripe during a request**.

**The application never asks what plan an organisation is on.** It asks what the organisation is
entitled to:

```ts
if (org.plan === 'PRO') { ... }                                    // forbidden
const limit = await entitlements.get(orgId, 'maxConcurrentScans');  // required
```

`Entitlement` is a flat `(organizationId, key, value, source)` table where `source` is `PLAN`,
`OVERRIDE`, or `PROMOTION`, and overrides win. Plans exist on the pricing page and in Stripe;
inside the application there are only entitlement keys.

Stripe Checkout in hosted mode — we never touch card data, keeping PCI scope minimal.

## Alternatives considered

**Build billing ourselves.** Rejected. Payment processing, SCA, tax, dunning, and invoicing are
enormous, regulated problems that are not our product.

**Query Stripe on demand for entitlement checks.** Rejected. Adds hundreds of milliseconds to
every request, and makes our authorization availability depend on Stripe's. A Stripe outage must
degrade billing operations, not lock every customer out of their own security data.

**Plan checks scattered through the code (`if plan === 'pro'`).** Rejected explicitly. It makes
grandfathering, enterprise negotiation, promotions, and trials impossible without touching
feature code, and it spreads commercial policy across hundreds of files. The specification calls
this out and it is right to.

**Trust the client after checkout completes.** Rejected. A checkout completing in the browser
changes nothing until the webhook arrives and is verified.

## Consequences

**Positive.** Entitlement checks are a fast local lookup. Custom enterprise terms are an
override row, not a code change. Stripe outages do not affect authorization. PCI scope stays
minimal. Adding a plan is seed data plus a Stripe product.

**Negative.** Webhook handling must be exactly right — raw-body signature verification, a
timestamp tolerance window, event-ID idempotency, and out-of-order protection comparing Stripe's
event timestamp against the projection's `lastEventAt`. A brief window exists between payment
and webhook where entitlements lag; acceptable, and the UI says "activating" rather than
showing a stale limit. The projection can drift and must be reconcilable — which is also why
disaster recovery re-projects from Stripe rather than trusting a restored projection.

**Negative, deliberately accepted.** **Downgrades never destroy data.** If a downgrade puts an
organisation over a limit, existing resources stay readable and exportable and only creation is
blocked. This costs us storage on downgraded accounts. Deleting a customer's security findings
because they moved to a cheaper plan is not something we will do.

**Neutral.** Usage counters increment in the same transaction as the action they measure, so
usage cannot drift from reality. Metered enterprise plans report to Stripe from hourly rollups.
