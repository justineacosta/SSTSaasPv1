# Plans and entitlements

> **Status: Designed. Not Implemented.** Phase 10.
> Architecture: [`../architecture/billing.md`](../architecture/billing.md) ·
> [ADR-0008](../decisions/ADR-0008-billing-architecture.md).

## 1. The rule

**The application never asks what plan an organisation is on.** It asks what an
organisation is entitled to:

```ts
// wrong — scatters plan knowledge through the codebase
if (org.plan === 'PRO') { ... }

// right
const limit = await entitlements.get(orgId, 'maxConcurrentScans');
```

Plans exist in the pricing page and in Stripe. Inside the application there are only
entitlement keys and values. This is what makes it possible to grandfather a customer,
negotiate a custom enterprise deal, or run a promotion without touching feature code.

## 2. Entitlement keys

| Key | Type | Meaning | Enforced at |
|---|---|---|---|
| `maxUsers` | int | Members in the organisation | Invitation and acceptance |
| `maxProjects` | int | Active projects | Project creation |
| `maxAssets` | int | Registered assets | Asset creation |
| `maxScansPerMonth` | int | Scans started per billing period | Scan creation |
| `maxConcurrentScans` | int | Simultaneously running scans | Scan creation **and** worker |
| `maxStorageBytes` | int | Evidence and report storage | Upload and generation |
| `maxEngagements` | int | Active engagements | Engagement creation |
| `scanProfiles` | list | Permitted profiles | Scan creation and worker |
| `engines` | list | Permitted engine IDs | Scan creation and worker |
| `reportFormats` | list | `HTML`, `PDF`, `JSON`, `CSV` | Report generation |
| `reportBranding` | bool | Custom logo and colours | Report generation |
| `apiAccess` | bool | API keys usable | API key creation and auth |
| `apiRateLimit` | int | Requests per minute | Rate limiter |
| `webhooks` | bool / int | Endpoints permitted | Webhook creation |
| `integrations` | list | Permitted integration IDs | Integration connection |
| `sso` | bool | SAML/OIDC | SSO configuration |
| `scim` | bool | Provisioning | SCIM endpoint |
| `customRoles` | bool | Beyond system roles | Role creation |
| `auditRetentionDays` | int | Audit retention | Scheduler retention job |
| `dataRetentionDays` | int | Findings, evidence, scan retention | Scheduler retention job |
| `supportTier` | enum | `COMMUNITY`/`STANDARD`/`PRIORITY`/`DEDICATED` | Support routing |

`-1` means unlimited. Every numeric key is checked **before** the action and, for anything
that reaches a worker, **again** at execution.

## 3. Plan defaults

Values are seed data, not constants in code, and are overridable per organisation.

| Entitlement | Free | Starter | Professional | Enterprise |
|---|---|---|---|---|
| Price / month | £0 | £99 | £399 | Custom |
| `maxUsers` | 2 | 10 | 50 | -1 |
| `maxProjects` | 1 | 5 | 25 | -1 |
| `maxAssets` | 5 | 50 | 500 | -1 |
| `maxScansPerMonth` | 10 | 200 | 2000 | -1 |
| `maxConcurrentScans` | 1 | 3 | 10 | Custom |
| `maxStorageBytes` | 1 GiB | 25 GiB | 250 GiB | Custom |
| `maxEngagements` | 0 | 2 | 20 | -1 |
| `scanProfiles` | `PASSIVE`, `SAFE` | + `STANDARD` | + `AGGRESSIVE` | All |
| `engines` | web | web, api | all GA | all incl. beta |
| `reportFormats` | `HTML` | `HTML`, `PDF` | all | all |
| `reportBranding` | no | no | yes | yes |
| `apiAccess` | no | yes | yes | yes |
| `apiRateLimit` | – | 300/min | 600/min | Custom |
| `webhooks` | 0 | 3 | 20 | -1 |
| `sso` / `scim` | no | no | no | yes |
| `customRoles` | no | no | yes | yes |
| `auditRetentionDays` | 30 | 90 | 365 | up to 2555 |
| `dataRetentionDays` | 90 | 365 | 730 | Custom |
| `supportTier` | Community | Standard | Priority | Dedicated |

## 4. Enforcement behaviour

A blocked action returns **402 Payment Required** with the entitlement key, the limit, the
current usage, and an upgrade link — never a generic error. The frontend shows the same
information inline rather than only after a failed attempt, and shows usage approaching a
limit before it is hit.

**Downgrades never destroy data.** If a downgrade puts an organisation over a limit,
existing resources remain readable and exportable; only *creation* is blocked until they are
under the limit. Deleting a customer's findings because they moved to a cheaper plan would
be indefensible.

Payment failure follows a dunning ladder: retry, notify, restrict creation while preserving
read access, and only then suspend. Read access to your own security data is the last thing
to go.

## 5. Usage metering

`UsageRecord` accumulates per organisation per period for scans started, storage consumed,
API requests, and reports generated. Rolled up by the scheduler, exposed at
`/billing/usage`, and used for both enforcement and — for metered enterprise plans —
reporting to Stripe.

## 6. Free plan and abuse

The free plan is a real product tier and a real abuse vector. It therefore requires a
verified email and verified asset ownership like every other tier, allows only `PASSIVE`
and `SAFE` profiles, has `maxConcurrentScans: 1`, and cannot register `IP` or `CIDR`
assets at all. See [`../security/abuse-prevention.md`](../security/abuse-prevention.md).
