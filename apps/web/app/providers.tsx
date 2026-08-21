'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** `system` follows the OS; the other two override it in both directions. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** design-system.md §5 — row height, padding and font size move together. */
export type Density = 'comfortable' | 'compact' | 'dense';

export interface Appearance {
  readonly theme: ThemePreference;
  readonly density: Density;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly setDensity: (density: Density) => void;
}

const AppearanceContext = createContext<Appearance | null>(null);

/**
 * Reads the appearance context. Throws rather than returning a default: a
 * silent default is how a component ends up rendering outside the provider
 * and nobody notices until the theme toggle does nothing.
 */
export function useAppearance(): Appearance {
  const value = useContext(AppearanceContext);
  if (value === null) throw new Error('useAppearance must be used inside <Providers>.');
  return value;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // This product's data changes underneath the user constantly
        // (architecture/frontend.md §3), so the window in which a cached
        // answer is trusted without revalidation is deliberately short.
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
      // A mutation that failed is a mutation the user should be told about,
      // not one the client should quietly try again — several of this
      // product's mutations start scans.
      mutations: { retry: 0 },
    },
  });
}

export function Providers({ children }: { children: ReactNode }): ReactNode {
  // Created once per browser session, inside state rather than at module
  // scope: a module-scope client is shared across every request on the server
  // and would leak one user's cached data into another's render.
  const [queryClient] = useState(createQueryClient);

  const [theme, setTheme] = useState<ThemePreference>('system');
  const [density, setDensity] = useState<Density>('comfortable');

  // The tokens in packages/ui already answer `prefers-color-scheme`, so
  // `system` means *remove* the attribute rather than compute a value. That is
  // also why nothing is applied during render: the server has no way to know
  // the OS preference, and guessing produces a flash of the wrong theme.
  //
  // Not yet persisted. A preference that survives a reload needs a
  // render-blocking inline script to set the attribute before first paint,
  // and that script needs the CSP nonce — deliberately deferred rather than
  // half-built, because a persisted preference that flashes the wrong theme
  // on every load is worse than one that does not persist.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  const appearance = useMemo<Appearance>(
    () => ({ theme, density, setTheme, setDensity }),
    [theme, density],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AppearanceContext.Provider value={appearance}>{children}</AppearanceContext.Provider>
    </QueryClientProvider>
  );
}
