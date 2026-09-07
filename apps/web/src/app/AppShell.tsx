'use client';

import { Alert, Button, Card, Skeleton } from '@sentinel/ui';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import { logout } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';
import { isSessionExpiry, loginHrefForDestination } from '../api/redirect';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { SessionContextProvider, useSessionQuery } from './session-context';
import { signOutLocally } from './sign-out';

/**
 * The navigation the shell draws once — and only once — the permission set is
 * known.
 *
 * Both entries are ungated today, and that is a statement rather than an
 * omission: `/settings/security` is self-service and has no permission
 * (`api/authentication.md` §2's argument for `@AuthenticatedOnly()`), and
 * `/settings/members` renders for any member, gating the *affordances* inside
 * it rather than the route. A route that vanishes from the navigation is a
 * worse permission state than a page that explains what is missing
 * (`architecture/frontend.md` §6).
 */
const NAVIGATION = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/members', label: 'Members' },
] as const;

/**
 * THE SKELETON, AND WHY IT IS THE WHOLE POINT OF THIS FILE.
 *
 * ADR-0025: the session is resolved in the browser, so there is a real moment
 * between first paint and the permission set arriving. Nothing
 * permission-gated, and no navigation item, renders in that moment. Rendering
 * an affordance and then withdrawing it is the flash of forbidden UI
 * `architecture/frontend.md` §2 bans, and it is banned no matter where the data
 * came from.
 *
 * It is a skeleton rather than a spinner because §6 asks for "skeletons
 * matching final layout, never a spinner alone, never layout shift".
 */
function ShellSkeleton(): ReactNode {
  return (
    <div
      className="flex flex-col gap-6"
      // The accessible half of a loading state. A screen reader is told the
      // region is busy; a sighted user sees the bars.
      aria-busy="true"
      aria-live="polite"
      data-testid="app-shell-skeleton"
    >
      <span className="sr-only">Loading your session…</span>
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * The authenticated product shell.
 *
 * # It resolves the session client-side, and that is ADR-0025
 *
 * The docblock this file replaced said the shell "fetches the effective
 * permission set server-side". ADR-0025 makes that false and this shell does
 * not do it: `useSessionQuery` runs in the browser, through the same
 * `ApiClient` every other authenticated call uses, with `credentials:
 * 'include'` against the API's own origin (ADR-0017). No cookie is forwarded
 * from a Next server component and there is no proxy route.
 *
 * # A 401 sends the user to login with the destination preserved
 *
 * `isSessionExpiry` and `loginHrefForDestination` were built and tested by Task
 * 16 with no caller. This is the caller. The destination is the path the user
 * was on, and it goes through `safeRedirectPath` on the way *in* as well as on
 * the way out — `loginHrefForDestination` does that itself.
 */
export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const query = useSessionQuery();
  const router = useRouter();
  const pathname = usePathname();

  const expired = isSessionExpiry(query.error);

  // In an effect rather than during render: a router navigation is a side
  // effect, and calling it while rendering is what produces React's "cannot
  // update a component while rendering a different component" warning — which
  // would then be a console error the e2e suite fails on.
  useEffect(() => {
    if (expired) router.replace(loginHrefForDestination(pathname));
  }, [expired, pathname, router]);

  if (query.isPending || expired) return <ShellSkeleton />;

  if (query.isError) {
    // §6's error state: what failed, what to do, a retry. The request ID is
    // carried by `ApiError` and rendered here because a support engineer
    // cannot trace a failure without it.
    const requestId =
      typeof query.error === 'object' && query.error !== null && 'requestId' in query.error
        ? (query.error as { requestId?: string | null }).requestId
        : null;

    return (
      <div className="flex flex-col gap-4">
        <Alert variant="danger">
          <span>
            Your session could not be loaded. This is usually temporary — try again, and if it keeps
            happening, contact support
            {requestId === null || requestId === undefined ? '' : ` and quote ${requestId}`}.
          </span>
        </Alert>
        <div>
          <Button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SessionContextProvider session={query.data}>
      <div className="flex flex-col gap-8">
        <ShellHeader />
        <main>{children}</main>
      </div>
    </SessionContextProvider>
  );
}

function ShellHeader(): ReactNode {
  const pathname = usePathname();
  const client = useApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OrganizationSwitcher />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void (async () => {
              try {
                await logout(client);
              } finally {
                // The cache is cleared whether or not the request succeeded,
                // and the reasoning lives in `signOutLocally` because
                // `SessionsPanel` makes the same call for a self-targeted
                // revocation (review finding C-2).
                signOutLocally(queryClient, router);
              }
            })();
          }}
        >
          Sign out
        </Button>
      </div>

      <nav aria-label="Product">
        <ul className="flex flex-wrap gap-4">
          {NAVIGATION.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'text-[length:var(--text-sm)] leading-[var(--leading-sm)] font-medium text-[var(--color-accent)] underline underline-offset-4'
                      : 'text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)] underline-offset-4 hover:underline'
                  }
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </Card>
  );
}
