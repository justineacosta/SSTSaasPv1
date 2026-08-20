# Billing architecture

> **Status: Designed. Not Implemented.** Phase 10.
> Plans and entitlement keys: [`../product/plans.md`](../product/plans.md) ·
> [ADR-0008](../decisions/ADR-0008-billing-architecture.md).

## 1. Principle

**Stripe is the source of truth for subscription state. The database holds a projection.**

The application never asks Stripe a question during a request — too slow, and it fails when
Stripe does. It reads the local projection, which webhooks keep current. And it never trusts
the client about anything billing-related: a checkout completing in the browser changes
nothing until the webhook arrives.

```
Stripe  ──webhook──▶  api  ──▶  Subscription row  ──project──▶  Entitlement rows
                                                                      │
                                                            read by every guard
```

## 2. Data model

`Subscription` — one per organisation: `stripeCustomerId`, `stripeSubscriptionId`, `planId`,
`status`, `currentPeriodStart/End`, `cancelAtPeriodEnd`, `trialEnd`.

`Entitlement` — `(organizationId, key, value, source)` where `source` is `PLAN`,
`OVERRIDE`, or `PROMOTION`. Overrides win, which is how enterprise deals and grandfathering
work without special-casing code.

`UsageRecord` — `(organizationId, periodStart, metric, value)` for scans, storage, API
requests, and reports.

`StripeEvent` — every processed event ID, for **idempotency**. Stripe redelivers; processing
the same event twice must be a no-op.

## 3. Webhook handling

The most security-sensitive endpoint in the system that is not authentication.

```
POST /api/v1/webhooks/stripe
  1. read the RAW body (signature is over raw bytes — parsing first breaks it)
  2. verify signature with STRIPE_WEBHOOK_SECRET; reject on failure
  3. reject if the timestamp is outside the tolerance window (replay defence)
  4. if event.id already in StripeEvent -> 200, do nothing
  5. transaction: record event, update Subscription, re-project Entitlements, audit
  6. return 200 quickly; slow follow-up work is queued
```

Events handled: `checkout.session.completed`, `customer.subscription.created/updated/deleted`,
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.trial_will_end`,
`payment_method.attached/detached`.

Out-of-order delivery is real. Every update compares Stripe's event timestamp against the
projection's `lastEventAt` and ignores stale events, so a late `updated` cannot resurrect a
cancelled subscription.

## 4. Entitlement projection

On any subscription change: load the plan's default entitlements, apply organisation
overrides, write the resulting rows in one transaction, and invalidate the Redis cache. New
limits are effective on the next request — no deploy, no restart, no waiting for a TTL.

Guards read entitlements through a cached accessor keyed by `(orgId, key)`, invalidated on
write. Anything enforced in a worker is re-read there, because entitlements can lapse between
enqueue and execution.

## 5. Flows

**Upgrade** — Stripe Checkout in hosted mode (we never touch card data; PCI scope stays
minimal) → webhook → projection → new limits live.
**Downgrade** — scheduled at period end by default. If it would put the org over a limit,
existing resources stay readable and exportable; only creation is blocked. **We never delete
customer data because they moved to a cheaper plan.**
**Cancellation** — `cancelAtPeriodEnd`, with access until the period ends, then the free
tier. Data retained per the free tier's retention, with warning emails before anything
expires.
**Payment failure** — Stripe's retry schedule, plus our dunning ladder: notify → restrict
creation → suspend, with read access to their own security data preserved as long as
possible.
**Trials** — 14 days on Professional entitlements, no card required; `trial_will_end` warns;
expiry drops to free tier limits without deleting anything.

## 6. Usage metering

Counters increment in the same transaction as the action they measure, so usage cannot drift
from reality. Hourly rollups aggregate into `UsageRecord`; metered enterprise plans report to
Stripe from the rollup. `/billing/usage` shows current period usage against limits, and the
UI warns at 80% rather than only failing at 100%.

## 7. Testing

Against the Stripe CLI and test mode, never against mocks of Stripe's behaviour: signature
verification rejects a bad signature and a stale timestamp; duplicate event IDs are no-ops;
out-of-order events are ignored; each lifecycle event projects the right entitlements; over-
limit downgrade preserves data and blocks creation; quota exhaustion returns 402 with usage
detail; a client claiming an upgraded plan without a webhook gets nothing.
