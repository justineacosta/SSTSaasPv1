# Frontend architecture

> **Status: Partially Implemented.** `apps/web` exists (Task 13): a Next.js 16 App Router
> shell with the three route groups from §1, self-hosted IBM Plex through `next/font`, the
> design system's tokens, TanStack Query and an appearance context (§3 partially — the
> provider is wired, no query is issued because there is no API to call), and the security
> header table with a per-request CSP nonce. §4 (forms), §5 (permissions), §6 (the six
> required states), §7 (performance budgets) and §8 (the component tree) are **Not
> Implemented** — they arrive with the features that need them. The only pages are a
> marketing landing page and an `(app)` placeholder that says the product is not built.
>
> **§2 is not yet honoured, deliberately — see the note at the end of §2.**

Next.js App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query, React Hook Form
with Zod.

## 1. Route groups

```
app/
  (marketing)/     public site — /, features, pricing, security, docs, legal
  (auth)/          login, register, forgot/reset, verify, mfa, recovery, invitations/[token]
  (onboarding)/    the wizard
  (app)/           authenticated product, wrapped in the app shell
  api/             BFF routes only — session cookie relay, CSP report, health
```

Route groups exist so each has its own layout, its own metadata strategy, and its own
loading and error boundaries. Full inventory: [`../ui-ux/page-map.md`](../ui-ux/page-map.md).

## 2. Rendering strategy

| Content | Strategy | Why |
|---|---|---|
| Marketing | Static, ISR for changelog and status | SEO and speed |
| Auth | Server components, dynamic | No caching of anything auth-adjacent |
| App shell, navigation | Server component | Permissions resolved server-side; no flash of forbidden UI |
| Lists and detail pages | Server component shell + client data | Fast first paint, interactive filtering |
| Realtime views (scan progress) | Client, SSE subscription | Live by definition |
| Charts | Client, lazy loaded | Heavy; not needed on first paint |

Never cached: any response containing tenant data. `Cache-Control: no-store` on authenticated
responses.

### Where the table is not true today (Phase 1)

**Every HTML route is currently `force-dynamic`**, marketing included — set once in
`apps/web/app/layout.tsx`. This is a conflict with `security/transport-and-headers.md` §3, not
an oversight, and it is structural rather than a misconfiguration: Next stamps the CSP nonce
onto its own inline bootstrap scripts by reading the CSP header off the **request**, and a
page prerendered at build time was never rendered for a request. Measured, not assumed —
built without `force-dynamic`, `/` compiled as `○ (Static)` and its prerendered HTML held
nine inline `<script>` tags carrying zero `nonce=` attributes. Because `script-src` includes
`'strict-dynamic'`, an enforcing policy blocks those scripts and everything they would have
loaded, so the page ships as dead HTML.

The choice is between a strict CSP and a prerendered marketing page, and Phase 1 takes the
CSP; `'unsafe-inline'` is the only other way to make prerendering work and it is banned. The
cost is real: no ISR, no CDN-cached HTML, a server render per request. Revisit when marketing
content actually exists and there is something for ISR to cache. The shape of the fix is a
CDN-level policy for the prerendered public routes — not a weaker policy everywhere.

## 3. Server state

TanStack Query, exclusively, for server data. React state is for UI state only. There is no
Redux-style global store — server data in a client store is a cache that nobody invalidates
correctly, and this product's data changes underneath the user constantly.

Query keys are structured and hierarchical, always including the organisation:

```ts
['org', orgId, 'findings', { status, severity, cursor }]
['org', orgId, 'finding', findingId]
```

Invalidation is by domain prefix on mutation. **Switching organisations clears the cache
entirely** — a stale cross-tenant render would be a security-visible bug even though the
data was legitimately fetched.

Realtime events invalidate the relevant query keys rather than patching the cache directly,
so the server stays the single source of truth. Optimistic updates are used only for
low-risk, instantly-reversible actions (assignment, tagging) and always roll back on error.

## 4. Forms

React Hook Form with a Zod resolver, using the **same schema the API validates with** from
`packages/contracts`. Client validation is a UX affordance; the server is the authority.

Every form: disables submit while pending, shows field-level errors tied to inputs by
`aria-describedby`, surfaces server errors mapped back to the offending field, keeps entered
data on failure (never clears a form because the server said no), warns before navigating
away with unsaved changes, and confirms destructive actions with a typed confirmation for
anything irreversible.

## 5. Permissions in the UI

The app shell fetches the effective permission set for the active organisation and provides
it through context. A `<Can permission="scan.create">` component and a `usePermission` hook
gate affordances.

**This is UX, not security.** Hidden actions are still rejected server-side. Where an action
is unavailable, the UI says *why* and who can grant it — a silently missing button generates
support tickets and makes the product feel broken.

## 6. Required states

Every data-bound view implements all six. A view missing any of them is incomplete and does
not pass review.

**Loading** — skeletons matching final layout, never a spinner alone, never layout shift.
**Empty** — explains what the thing is, why it is empty, and the primary action inline.
**Error** — what failed, what to do, a retry, and the request ID for support.
**Partial** — some data loaded, some failed; show what we have and mark what is missing.
**Permission** — explains the missing permission rather than showing a blank page.
**Success** — toast for background actions, inline confirmation for in-context ones.

## 7. Performance

Route-level code splitting by default; heavy components (charts, evidence viewer, report
preview) lazy-loaded. Long lists virtualised past ~100 rows. Filters debounced. `next/image`
for all images. Bundle budgets enforced in CI, with the build failing on regression rather
than warning about it.

## 8. Structure

```
components/ui/         design system primitives (shadcn)
components/patterns/   page-level patterns: DataTable, PageHeader, EmptyState, ConfirmDialog
components/domain/     domain components: FindingRow, SeverityBadge, ScanProgress
hooks/  lib/  providers/
```

Domain components never fetch. They receive data and callbacks, which keeps them testable
and reusable across pages that load their data differently.
