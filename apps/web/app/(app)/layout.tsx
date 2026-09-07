import type { ReactNode } from 'react';
import { AppShell } from '../../src/app/AppShell';

/**
 * The authenticated product shell.
 *
 * **This layout does NOT fetch the session, and the docblock that said it did
 * is corrected here rather than left to rot.** Until Task 17 it read: "The real
 * shell resolves the active organisation, fetches the effective permission set
 * server-side and provides it through context". `ADR-0025` makes the
 * server-side half false. Every authenticated API call in this application is
 * made **from the browser**, including the shell's own session read, and the
 * `__Host-session` cookie is never forwarded from a Next server component.
 *
 * The measured reason is in the ADR: `passwordChange` and `mfaManagement`
 * declare `perIp` as their only scope, 10/hour, fail closed
 * (`apps/api/src/common/guards/rate-limit.config.ts:208` and `:303`), and
 * between them they guard all five routes `/settings/security` is built on. A
 * server-originated call would share one source address across the whole
 * deployment.
 *
 * So this file stays a server component that renders one client component. The
 * session resolves in `AppShell`, which renders a **skeleton** until it does —
 * no navigation item and nothing permission-gated appears before the permission
 * set is known.
 *
 * Nothing here sets `Cache-Control`. It does not need to: every HTML route in
 * this app is `force-dynamic` (see `app/layout.tsx`), and Next answers a dynamic
 * route with `private, no-cache, no-store, max-age=0, must-revalidate` on its
 * own — measured against `next start`, not assumed.
 * `transport-and-headers.md` §2's requirement is therefore already met for this
 * group. Revisit if any route under it ever stops being dynamic.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <AppShell>{children}</AppShell>
    </div>
  );
}
