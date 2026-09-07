'use client';

import type { Permission, SessionOrganization, SessionResponse } from '@sentinel/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fetchSession } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';

/**
 * THE ONE QUERY KEY FOR THE SESSION DOCUMENT.
 *
 * **Deliberately not organisation-scoped**, unlike every other key in this app
 * (`architecture/frontend.md` §3). ADR-0025 states the reason: the session *is*
 * what names the active organisation, so scoping its key by the answer it
 * returns would be circular — the key could not be built until the query it
 * keys had already run.
 */
export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * What the shell knows about the caller once the session has resolved.
 *
 * `permissions` is the **effective** set for the active organisation, computed
 * by the API. It is `[]` whenever no organisation is active, the membership is
 * not active, or the organisation is suspended — `api/authorization.md` §2.
 */
export interface SessionContextValue {
  readonly userId: string;
  readonly activeOrganization: SessionOrganization | null;
  readonly permissions: readonly Permission[];
  readonly entitlements: Readonly<Record<string, unknown>>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The session, or a throw.
 *
 * It throws rather than returning a nullable value, and that is what makes the
 * skeleton load-bearing: a component that renders inside `<AppShell>` is only
 * ever mounted once the session has resolved, so there is no "session might be
 * undefined" branch for a permission check to be forgotten in. A hook returning
 * `null` while loading is how a gate ends up evaluated against an empty
 * permission set and an affordance is withdrawn a moment after it appeared —
 * the flash of forbidden UI `architecture/frontend.md` §2 bans.
 */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside the authenticated app shell.');
  }
  return value;
}

/**
 * WHETHER THE UI SHOULD OFFER AN ACTION. **THIS IS UX ONLY, NOT SECURITY.**
 *
 * It is a mirror of server-side rules, never the rules themselves. Every action
 * it permits is re-authorised server-side, and every action it hides is still
 * rejected if called directly — `architecture/frontend.md` §5 and
 * `api/authorization.md` §2. Hiding a button prevents nothing; the API is what
 * prevents it.
 *
 * A future reader must not be able to mistake this for a control, which is why
 * the sentence above is in this docstring in those words rather than in a
 * design document three directories away.
 */
export function usePermission(permission: Permission): boolean {
  return useSession().permissions.includes(permission);
}

/**
 * Renders `children` when the caller holds `permission`.
 *
 * **UX only, not security** — the same sentence as `usePermission` above, and
 * for the same reason. A `<Can>` that wraps a button hides the button; the
 * server is what refuses the request the button would have made.
 *
 * `fallback` exists because `architecture/frontend.md` §6 requires a permission
 * state that "explains the missing permission rather than showing a blank
 * page". A silently missing affordance generates support tickets and makes the
 * product feel broken.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  return usePermission(permission) ? children : fallback;
}

/**
 * The one place `GET /api/v1/auth/session` is read, and it is read **from the
 * browser** (ADR-0025).
 *
 * The session is not server-rendered and the `__Host-session` cookie is never
 * forwarded from a Next server component. The measured reason is in the ADR:
 * `passwordChange` and `mfaManagement` are `perIp`-only and fail closed, so a
 * server-originated call would share one address across the whole deployment.
 * One pattern, not two.
 *
 * `retry: false` because the failure this query has is a 401, and retrying a
 * 401 delays the redirect to login by however long the backoff takes while
 * producing the same answer three times.
 */
export function useSessionQuery(): UseQueryResult<SessionResponse> {
  const client = useApiClient();
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(client, signal),
    retry: false,
  });
}

export function SessionContextProvider({
  session,
  children,
}: {
  session: SessionResponse;
  children: ReactNode;
}): ReactNode {
  const value = useMemo<SessionContextValue>(
    () => ({
      userId: session.userId,
      activeOrganization: session.activeOrganization,
      permissions: session.permissions,
      entitlements: session.entitlements,
    }),
    [session],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
