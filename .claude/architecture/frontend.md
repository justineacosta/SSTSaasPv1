# Frontend architecture

> **Status: Designed. Not Implemented.** Phase 1 onward.

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
