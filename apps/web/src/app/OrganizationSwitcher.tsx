'use client';

import { Alert, Skeleton } from '@sentinel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { switchOrganization } from '../api/auth-endpoints';
import { listOrganizations } from '../api/organization-endpoints';
import { useApiClient } from '../api/provider';
import { SESSION_QUERY_KEY, useSession } from './session-context';

/**
 * SWITCHING ORGANISATIONS CLEARS THE ENTIRE QUERY CACHE.
 *
 * `architecture/frontend.md` §3, in its own words: "Switching organisations
 * clears the cache entirely — a stale cross-tenant render would be a
 * security-visible bug even though the data was legitimately fetched."
 *
 * `queryClient.clear()`, not a selective invalidation reasoned about key by
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
 * `OrganizationSwitcher.spec.tsx` asserts the property directly — data cached
 * under organisation A is gone after switching to B — and the mutation that
 * proves it bites (removing the `clear()` call) is recorded in this task's
 * report.
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
      // ORDER MATTERS. The cache is emptied first, then the fresh session
      // document is seeded, so the new session cannot be swept away by its own
      // switch and nothing cached under the previous organisation survives.
      queryClient.clear();
      queryClient.setQueryData(SESSION_QUERY_KEY, next);
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
