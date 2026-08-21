import type { ReactNode } from 'react';

/**
 * The authenticated product shell.
 *
 * It is a bare column today on purpose. The real shell resolves the active
 * organisation, fetches the effective permission set server-side and provides
 * it through context (architecture/frontend.md §5) — none of which exists,
 * because there is no authentication and no organisation. Drawing a
 * navigation sidebar next to links that go nowhere would make this look
 * finished; it is not.
 *
 * Nothing here sets `Cache-Control`. It does not need to: every HTML route in
 * this app is `force-dynamic` (see app/layout.tsx), and Next answers a dynamic
 * route with `private, no-cache, no-store, max-age=0, must-revalidate` on its
 * own — measured against `next start`, not assumed. transport-and-headers.md
 * §2's requirement is therefore already met for this group. Revisit if any
 * route under it ever stops being dynamic.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactNode {
  return <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">{children}</div>;
}
