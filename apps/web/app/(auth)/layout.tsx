import type { ReactNode } from 'react';

/**
 * The authentication shell — a single centred column, no navigation, nothing
 * to click away to.
 *
 * **No route renders through this layout yet.** `/login`, `/register`,
 * `/mfa`, `/invitations/[token]` and the rest of `(auth)` are Phase 2
 * (ui-ux/page-map.md), and there is no authentication in this codebase to
 * render them against. The layout exists now so the group boundary is real
 * from the start: `(auth)` responses are dynamic and never cached
 * (architecture/frontend.md §2), and that is a property of the group, not of
 * each page that will later be added to it.
 */
export default function AuthLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
