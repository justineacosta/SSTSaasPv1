import type { QueryClient } from '@tanstack/react-query';

/** The half of `next/navigation`'s router this module needs, and no more. */
export interface SignOutRouter {
  replace(href: string): void;
}

/**
 * WHAT THE BROWSER DOES ONCE THE SERVER HAS ENDED THE SESSION.
 *
 * Two callers, one function, deliberately: `AppShell`'s Sign out button and
 * `SessionsPanel`'s revocation of the row marked `current`. Both end in the
 * same server state — `auth.controller.ts` clears `__Host-session` and
 * `__Host-csrf` identically on `POST /auth/logout` and on a self-targeted
 * `DELETE /auth/sessions/:id` — so both must end in the same browser state.
 *
 * Review finding C-2 is what happens when they do not: the panel invalidated
 * one query key, the refetch 401'd, and the user read "Your sessions could not
 * be loaded. Try again in a moment." underneath a shell still drawing
 * signed-in chrome. Copying the two lines instead of sharing them is how the
 * next divergence gets written.
 *
 * # Why `clear()` here and `resetQueries()` in the organisation switcher
 *
 * Finding C-4 measured that `clear()` empties the store without notifying the
 * observers mounted on it, which is fatal for a switch — the shell stays
 * mounted and keeps rendering the previous organisation. It is not fatal here:
 * `/login` is outside the `(app)` layout, so the whole subscribed tree
 * unmounts and there is no observer left that needs telling. What matters here
 * is that the store is *emptied*, and emptied whether or not the request
 * succeeded — one user's cached data outliving their sign-out is the failure
 * this exists to prevent, and a failed sign-out is when it matters most.
 *
 * The navigation is `replace`, not `push`: Back must not return to a page that
 * will only 401.
 */
export function signOutLocally(queryClient: QueryClient, router: SignOutRouter): void {
  queryClient.clear();
  router.replace('/login');
}
