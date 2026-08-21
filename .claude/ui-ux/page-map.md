# Page map

Complete route inventory. **Every route listed is Not Implemented as of 2026-08-21**; the
Phase column is the commitment. A route ships only when it has all six required states
([`../architecture/frontend.md`](../architecture/frontend.md) §6) — a route that renders but
has no empty or error state is not done.

Two URLs now answer, and neither counts as a shipped route. `/` renders a marketing landing
page that describes the product and says outright that nothing on it is a demo. `/dashboard`
renders a placeholder that says the product is not built and names the current phase — it is
not the `/dashboard` in the `(app)` table below, which is a live-metrics view committed to
Phase 5, and it deliberately shows no mock product UI. `(auth)` has a layout and no routes at
all. See [`../product/roadmap.md`](../product/roadmap.md).

## Marketing — `(marketing)`

| Route | Purpose | Phase |
|---|---|---|
| `/` | Landing: problem, product, proof, CTA | 1 |
| `/features` | Capability detail | 5 |
| `/features/[slug]` | Per-capability deep dive | 6 |
| `/solutions` | By persona and by use case | 7 |
| `/solutions/[slug]` | Individual solution | 7 |
| `/security` | Our own security posture — table stakes for this category | 1 |
| `/pricing` | Plans, comparison, FAQ. **Generated from plan seed data** so it cannot disagree with entitlements | 10 |
| `/documentation` | Docs home | 5 |
| `/documentation/[...slug]` | Docs pages | 5 |
| `/customers` | Case studies | 11 |
| `/about` | Company | 1 |
| `/contact` | Sales and support contact | 1 |
| `/changelog` | Product updates, ISR | 5 |
| `/status` | Service status | 4 |
| `/terms`, `/privacy`, `/security-policy` | Legal; security policy includes vulnerability disclosure | 1 |

SEO: per-route metadata, OpenGraph and Twitter cards, JSON-LD (`Organization`,
`SoftwareApplication`, `FAQPage`, `BreadcrumbList`), sitemap, robots, canonical URLs.

## Authentication — `(auth)`

| Route | Phase |
|---|---|
| `/login` — email + password, then MFA if enrolled | 2 |
| `/register` | 2 |
| `/forgot-password`, `/reset-password` | 2 |
| `/verify-email` | 2 |
| `/mfa` — challenge against the pending session | 2 |
| `/mfa/enroll` — QR, verify, recovery codes shown once | 2 |
| `/recovery` — recovery code entry | 2 |
| `/invitations/[token]` — accept, sign in or register as the invited address | 2 |
| `/sso/[slug]` — SSO initiation | 11 |

## Onboarding — `(onboarding)`

`/onboarding` with resumable steps persisted server-side: `organization`, `team`, `project`,
`asset`, `verify` (**not skippable**), `scope`, `profile`, `scan`, `results`. Phase 2–5.

## Application — `(app)`

### Overview and work
| Route | Phase |
|---|---|
| `/dashboard` — live metrics, no hardcoded numbers | 5 |
| `/search` — cross-domain results | 3 |
| `/notifications` | 3 |

### Organisations and projects
| Route | Phase |
|---|---|
| `/organizations`, `/organizations/[id]`, `/organizations/[id]/settings` | 2 |
| `/projects`, `/projects/new`, `/projects/[id]`, `/projects/[id]/settings` | 3 |

### Assets and scope
| Route | Phase |
|---|---|
| `/assets`, `/assets/new`, `/assets/[id]` | 3 |
| `/assets/[id]/verify` — ownership verification, per-method instructions, live re-check | 3 |
| `/scopes`, `/scopes/new`, `/scopes/[id]` | 3 |
| `/scopes/[id]/simulate` — test a target against the rules before scanning | 3 |

`/scopes/[id]/simulate` is not in the original route list but earns its place: scope debugging
by trial-and-error against a live scanner is exactly the behaviour we do not want to
encourage.

### Scanning
| Route | Phase |
|---|---|
| `/scans` — history, filterable | 4 |
| `/scans/new` — asset, engine, profile, config, **scope preview before submit** | 4 |
| `/scans/[id]` — live progress, logs, findings as they arrive | 4 |
| `/scans/schedules`, `/scans/schedules/[id]` | 5 |

### Findings
| Route | Phase |
|---|---|
| `/findings` — the triage queue; the most-used view in the product | 5 |
| `/findings/[id]` — detail, evidence, occurrences, activity, retests | 5 |

### Pentest workspace
| Route | Phase |
|---|---|
| `/engagements`, `/engagements/new`, `/engagements/[id]` | 7 |
| `/engagements/[id]/test-cases`, `/engagements/[id]/findings`, `/engagements/[id]/report` | 7 |
| `/test-cases`, `/test-cases/new`, `/test-cases/[id]` — methodology templates | 7 |
| `/evidence`, `/evidence/[id]` | 5 |
| `/retests`, `/retests/[id]` | 7 |

### Reports
| Route | Phase |
|---|---|
| `/reports`, `/reports/new`, `/reports/[id]` | 8 |

### Team and access
| Route | Phase |
|---|---|
| `/team`, `/team/members/[id]`, `/team/invitations` | 2 |
| `/api-keys` | 9 |
| `/webhooks`, `/webhooks/[id]` — including delivery log | 9 |
| `/integrations`, `/integrations/[id]` | 9 |
| `/audit-logs` | 3 |

### Billing
| Route | Phase |
|---|---|
| `/billing`, `/billing/plans`, `/billing/usage`, `/billing/invoices` | 10 |

### Settings
| Route | Phase |
|---|---|
| `/settings/profile` | 2 |
| `/settings/security` — password, MFA, active sessions | 2 |
| `/settings/organization` | 2 |
| `/settings/members`, `/settings/roles` | 2 / 11 |
| `/settings/notifications` | 3 |
| `/settings/integrations`, `/settings/api` | 9 |
| `/settings/audit` | 3 |
| `/settings/retention` | 11 |

## Platform admin — separate deployment, `admin.` subdomain

`/admin`, `/admin/organizations[/[id]]`, `/admin/users[/[id]]`, `/admin/verifications`
(manual IP/CIDR review queue), `/admin/abuse`, `/admin/system`, `/admin/workers`,
`/admin/flags`, `/admin/audit`. Phase 11.

## Error and utility

`not-found.tsx`, `error.tsx`, and `loading.tsx` per route group; `/403` permission state;
`/suspended`; `/maintenance`. Phase 1.

## Route-level requirements

Every application route: server-side permission check in the layout or page (**not** only a
client guard); metadata title following `{Page} · {Organization} · Sentinel`; breadcrumbs to
the root; loading skeleton matching final layout; empty, error, partial, and permission
states; keyboard reachable; responsive to 360px.
