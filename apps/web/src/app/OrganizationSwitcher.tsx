'use client';

import { Alert, Skeleton } from '@sentinel/ui';
import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { switchOrganization } from '../api/auth-endpoints';
import { listOrganizations } from '../api/organization-endpoints';
import { useApiClient } from '../api/provider';
import { SESSION_QUERY_KEY, useSession } from './session-context';

/**
 * The session query's hash, computed once. `resetQueries` filters have no
 * negation, so "every query except this one" is a predicate, and a predicate
 * comparing hashes is exact where comparing `queryKey[0]` would also spare a
 * future `['session', …]` key nobody meant to spare.
 */
const SESSION_QUERY_HASH = hashKey(SESSION_QUERY_KEY);

/**
 * SWITCHING ORGANISATIONS EMPTIES THE ENTIRE QUERY CACHE — AND REPAINTS.
 *
 * `architecture/frontend.md` §3, in its own words: "Switching organisations
 * clears the cache entirely — a stale cross-tenant render would be a
 * security-visible bug even though the data was legitimately fetched."
 *
 * A total reset, not a selective invalidation reasoned about key by
 * key. The difference matters and it is not stylistic: a selective
 * invalidation is only as correct as the list of prefixes somebody remembered
 * to include, and the failure mode of forgetting one is a page rendering
 * Tenant A's data under Tenant B's name. The user sees it. There is no key
 * naming convention that makes "did I list them all" checkable, and every
 * future feature adds another key.
 *
 * The cost is a refetch of everything, on an action a user takes rarely and
 * deliberately. That is the correct trade.
 *
 * # EMPTYING THE STORE IS NOT ENOUGH. THE SCREEN HAS TO BE TOLD.
 *
 * This originally shipped as `queryClient.clear()`, and review finding C-4
 * measured what that does and does not do. `clear()` reaches
 * `QueryCache.clear()`, which calls `remove(query)` for every entry:
 * `query.destroy()` — `super.destroy()` plus `cancel({ silent: true })`, which
 * suppresses any dispatch — and then a delete from the map. It never touches
 * `query.observers`. A mounted `QueryObserver` subscribes to its *query*, not
 * to the cache, and reassigns its current query only from `setOptions` /
 * `onSubscribe`, i.e. only when React re-renders the hook. So after `clear()`
 * every mounted observer holds a destroyed, unreachable query and is notified
 * **zero** times, while `setQueryData` writes into a freshly built query with
 * no observers on it. The store is empty and the shell goes on rendering the
 * previous organisation's name and permission set until a navigation or a
 * reload. That is the stale cross-tenant render §3 calls security-visible,
 * produced by the very call meant to prevent it.
 *
 * `resetQueries()` is the primitive that does both halves. `Query.reset()` is
 * `destroy(); setState(this.resetState)`, and that `setState` dispatches — so
 * every mounted observer is notified, active queries refetch under the new
 * organisation, and inactive ones are left holding their initial state, which
 * carries no data. Read out of `@tanstack/query-core@5.101.4` (`query.js`,
 * `queryClient.js`) rather than assumed, and asserted on screen by
 * `AppShell.spec.tsx`'s "switching organisation REPAINTS the shell" block.
 *
 * # WHY THE SESSION KEY IS EXCLUDED, AND WHY THAT IS STILL TOTAL
 *
 * The session query is the one entry that must not be emptied and refetched:
 * resetting it puts `useSessionQuery` back into `isPending`, which makes
 * `AppShell` swap the whole shell for its skeleton and unmount the page
 * mid-switch, and it costs a redundant `GET /auth/session` for a document the
 * switch response already returned. It is excluded from the reset and
 * *overwritten* instead, so nothing belonging to the previous organisation
 * survives it either — the previous session document is replaced, not kept.
 * The mutation store is cleared separately, because `clear()` used to do that
 * and a mutation's cached `data` belonged to the previous organisation too.
 *
 * `OrganizationSwitcher.spec.tsx` asserts the store is emptied — including keys
 * that never named an organisation — and `AppShell.spec.tsx` asserts the screen
 * changes with it. Both halves have a test because shipping only the first is
 * exactly how C-4 happened.
 */
export function OrganizationSwitcher(): ReactNode {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const selectId = useId();

  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: ({ signal }) => listOrganizations(client, signal),
  });

  const switcher = useMutation({
    mutationFn: (organizationId: string) => switchOrganization(client, { organizationId }),
    onSuccess: (next) => {
      // ORDER MATTERS, and so does the primitive. The fresh session document is
      // written first and then excluded from the reset by hash, so the switch
      // cannot sweep away its own result; everything else is reset, which
      // empties it AND notifies the observers mounted on it. See the docblock
      // above for the measurement that `clear()` does only the first of those.
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
      void queryClient.resetQueries({
        predicate: (query) => query.queryHash !== SESSION_QUERY_HASH,
      });
      queryClient.getMutationCache().clear();
    },
  });

  if (organizations.isPending) {
    return <Skeleton className="h-8 w-48" data-testid="organizations-skeleton" />;
  }

  if (organizations.isError) {
    return (
      <Alert variant="danger">
        <span>Your organisations could not be loaded.</span>
      </Alert>
    );
  }

  const rows = organizations.data.data;

  if (rows.length === 0) {
    // §6's empty state: what the thing is, why it is empty, and what to do.
    return (
      <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
        You do not belong to an organisation yet. An invitation from an existing member is how you
        join one.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={selectId}
        className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]"
      >
        Organisation
      </label>
      <select
        id={selectId}
        value={session.activeOrganization?.id ?? ''}
        disabled={switcher.isPending}
        onChange={(event) => {
          const next = event.target.value;
          if (next.length === 0 || next === session.activeOrganization?.id) return;
          switcher.mutate(next);
        }}
        className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text)]"
      >
        {session.activeOrganization === null ? (
          <option value="">Choose an organisation</option>
        ) : null}
        {rows.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
      {switcher.isError ? (
        <span
          role="alert"
          className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-danger)]"
        >
          That organisation could not be switched to.
        </span>
      ) : null}
    </div>
  );
}
