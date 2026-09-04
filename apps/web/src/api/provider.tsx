'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client';

const ApiClientContext = createContext<ApiClient | null>(null);

/**
 * Makes one {@link ApiClient} available to the client tree.
 *
 * ADR-0024 is why this is context rather than a module-scope singleton: the
 * API origin is read from the environment on the **server**, passed into the
 * provider tree as a prop, and never inlined into the browser bundle as a
 * `NEXT_PUBLIC_` variable. The ADR names the ergonomic cost out loud — every
 * consumer must be a client component under this provider, and a non-React
 * caller has to be handed the base URL explicitly.
 *
 * Taking a built client rather than a base URL keeps the seam a test can use:
 * a component spec renders its screen under this provider with a fake, and
 * never touches `fetch`.
 */
export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}): ReactNode {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

/**
 * Throws rather than returning a default. A silent default is how a component
 * ends up rendering outside the provider and nobody notices until every
 * request goes to the wrong origin — the same argument `useAppearance` in
 * `app/providers.tsx` makes for itself.
 */
export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('useApiClient must be used inside <ApiClientProvider>.');
  return client;
}
