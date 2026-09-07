import { ERROR_CODES } from '@sentinel/contracts';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { AppShell } from './AppShell';
import {
  pendingClient,
  renderApp,
  stubClient,
  testQueryClient,
  type RecordedRequest,
} from './render-helpers';
import { useSession } from './session-context';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const pathname = vi.hoisted(() => ({ current: '/settings/security' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => pathname.current,
}));

const USER_ID = 'usr_01M0T74WZZFY9T2QS56RGF3GQ8';
const ORG_ID = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';

const SESSION = {
  userId: USER_ID,
  activeOrganization: { id: ORG_ID, slug: 'acme', name: 'Acme' },
  permissions: ['organization.read'],
  entitlements: {},
};

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  pathname.current = '/settings/security';
});

describe('AppShell — the skeleton is what stands between first paint and the permission set', () => {
  it('LOADING: renders a skeleton and NO navigation while the session is in flight', () => {
    renderApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
      pendingClient(),
    );

    expect(screen.getByTestId('app-shell-skeleton')).toBeInTheDocument();

    // THE ASSERTION THAT MATTERS. ADR-0025 and frontend.md §2: no affordance
    // renders before the permission set is known. A navigation item that
    // appeared here and stayed would look harmless; one that appeared and was
    // withdrawn is the flash of forbidden UI. Neither may happen, so nothing
    // renders at all.
    expect(screen.queryByRole('navigation', { name: 'Product' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    // The page body is withheld too: a child could gate on `usePermission`, and
    // a child rendered before the provider exists would throw.
    expect(screen.queryByText('page body')).not.toBeInTheDocument();
  });

  it('SUCCESS: renders the navigation and the body once the session resolves', async () => {
    const { client } = stubClient(() => SESSION);
    renderApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
      client,
    );

    expect(await screen.findByRole('navigation', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell-skeleton')).not.toBeInTheDocument();
  });

  it('reads the session from the browser, at the API path, with no proxy in between', async () => {
    const { client, requests } = stubClient(() => SESSION);
    renderApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
      client,
    );
    await screen.findByRole('navigation', { name: 'Product' });

    // ADR-0025's observable consequence: one GET, straight at the API's own
    // path. A Next proxy route would show up here as `/api/session` or similar.
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/auth/session' });
  });

  it('marks the current route with aria-current and no other', async () => {
    pathname.current = '/settings/members';
    const { client } = stubClient(() => SESSION);
    renderApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
      client,
    );

    const current = await screen.findByRole('link', { current: 'page' });
    expect(current).toHaveAccessibleName('Members');
  });
});

describe('AppShell — a 401 sends the user to login with the destination preserved', () => {
  it('redirects through loginHrefForDestination and never renders the shell', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.SESSION_EXPIRED,
        message: 'Your session has ended.',
        requestId: 'req_01',
      });
    });

    renderApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
      client,
    );

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/login?next=%2Fsettings%2Fsecurity');
    });

    // A skeleton, not the error card and not the shell: the user is on their
    // way to the sign-in page and a flash of "something went wrong" would be a
    // lie about what happened.
    expect(screen.getByTestId('app-shell-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Product' })).not.toBeInTheDocument();
  });

  it('treats UNAUTHENTICATED the same as SESSION_EXPIRED', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Sign in to continue.',
        requestId: 'req_02',
      });
    });

    renderApp(<AppShell>{null}</AppShell>, client);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/login?next=%2Fsettings%2Fsecurity');
    });
  });

  it('does NOT redirect on a failure that is not an expiry', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'network',
        message: 'Could not reach the Sentinel API.',
      });
    });

    renderApp(<AppShell>{null}</AppShell>, client);

    // §6's error state, with a retry — not a bounce to the sign-in page, which
    // would sign the user out because their connection dropped.
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('ERROR: carries the request ID into the error state', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 500,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong.',
        requestId: 'req_trace_me',
      });
    });

    renderApp(<AppShell>{null}</AppShell>, client);

    // frontend.md §6: an error state carries "the request ID for support".
    expect(await screen.findByText(/req_trace_me/)).toBeInTheDocument();
  });
});

describe('AppShell — switching organisation REPAINTS the shell (review C-4)', () => {
  // THE TEST THE SHIPPED SUITE DID NOT HAVE. `OrganizationSwitcher.spec.tsx`
  // renders the switcher under a *static* `SessionContextProvider` and asserts
  // `queryClient.getQueryData(...)` — the half that works. This mounts the real
  // `AppShell`, whose session comes from `useSessionQuery`'s live observer, with
  // the real `OrganizationSwitcher` inside it, and asserts what is ON SCREEN.
  //
  // The failure it exists to catch: `queryClient.clear()` empties the store and
  // destroys every Query object without notifying the observers mounted on
  // them, so the shell keeps rendering the previous organisation's name and
  // permission set indefinitely while the server session has already moved.
  // That is `architecture/frontend.md` §3's "stale cross-tenant render" —
  // visible to the user, and not caught by any assertion against the cache.

  const ORG_B = 'org_01M0T74WZZFY9T2QS56RGF3GQ9';

  const organization = (id: string, slug: string, name: string) => ({
    id,
    slug,
    name,
    status: 'ACTIVE' as const,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  });

  const SESSIONS: Record<string, unknown> = {
    [ORG_ID]: {
      userId: USER_ID,
      activeOrganization: { id: ORG_ID, slug: 'acme', name: 'Acme' },
      permissions: ['organization.read'],
      entitlements: {},
    },
    [ORG_B]: {
      userId: USER_ID,
      activeOrganization: { id: ORG_B, slug: 'globex', name: 'Globex' },
      permissions: ['organization.manage_members'],
      entitlements: {},
    },
  };

  /**
   * A stub that behaves the way the real API does: the active organisation
   * lives on the cookie, not in the URL, so EVERY route answers for whichever
   * organisation the session currently names. A stub that answered from the
   * request path would hide the finding, because the page would appear to
   * change tenant without the session having done anything.
   */
  function statefulApi(): (request: RecordedRequest) => unknown {
    let active = ORG_ID;
    return (request) => {
      if (request.path === '/api/v1/auth/session') return SESSIONS[active];
      if (request.path === '/api/v1/organizations') {
        return {
          data: [organization(ORG_ID, 'acme', 'Acme'), organization(ORG_B, 'globex', 'Globex')],
          pagination: { nextCursor: null, hasMore: false, limit: 50 },
        };
      }
      if (request.path === '/api/v1/auth/switch-org') {
        active = (request.body as { organizationId: string }).organizationId;
        return SESSIONS[active];
      }
      throw new Error(`unexpected request: ${request.method} ${request.path}`);
    };
  }

  function Probe(): ReactNode {
    const session = useSession();
    return (
      <>
        <p data-testid="probe-org">{session.activeOrganization?.name ?? 'no organisation'}</p>
        <p data-testid="probe-permissions">{session.permissions.join(' ')}</p>
      </>
    );
  }

  it('RENDERS THE NEW ORGANISATION, not the previous one, after the switch', async () => {
    const { client } = stubClient(statefulApi());
    renderApp(
      <AppShell>
        <Probe />
      </AppShell>,
      client,
    );

    expect(await screen.findByTestId('probe-org')).toHaveTextContent('Acme');

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    // The whole finding in three assertions: the cache moved to Globex and the
    // screen did not.
    await waitFor(() => {
      expect(screen.getByTestId('probe-org')).toHaveTextContent('Globex');
    });
    expect(screen.getByTestId('probe-org')).not.toHaveTextContent('Acme');
    expect(screen.getByLabelText('Organisation')).toHaveValue(ORG_B);
  });

  it('RENDERS THE NEW PERMISSION SET, so every gate under the shell is re-evaluated', async () => {
    const { client } = stubClient(statefulApi());
    renderApp(
      <AppShell>
        <Probe />
      </AppShell>,
      client,
    );

    expect(await screen.findByTestId('probe-permissions')).toHaveTextContent('organization.read');

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    // C-6: `usePermission` and `<Can>` are UX only, so a frozen permission set
    // misinforms rather than authorises. It is still the previous tenant's
    // rights being used to decide what this tenant's user is offered.
    await waitFor(() => {
      expect(screen.getByTestId('probe-permissions')).toHaveTextContent(
        'organization.manage_members',
      );
    });
    expect(screen.getByTestId('probe-permissions')).not.toHaveTextContent('organization.read');
  });

  it('does not leave the PREVIOUS organisation’s page data on screen', async () => {
    // A page keyed without an organisation id is the case a selective
    // invalidation misses and the case `clear()` was chosen for. Emptying the
    // store is not enough: an observer that is never told refetches nothing and
    // keeps rendering the row it already has.
    function FindingsProbe(): ReactNode {
      const rows = useQuery({
        queryKey: ['findings'],
        queryFn: () => Promise.resolve(['a finding']),
      });
      return <p data-testid="probe-findings">{rows.data?.join(' ') ?? 'no findings'}</p>;
    }

    const queryClient = testQueryClient();
    const { client } = stubClient(statefulApi());
    renderApp(
      <AppShell>
        <FindingsProbe />
      </AppShell>,
      client,
      queryClient,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-findings')).toHaveTextContent('a finding');
    });

    queryClient.setQueryData(['findings'], ["Acme's finding"]);
    await waitFor(() => {
      expect(screen.getByTestId('probe-findings')).toHaveTextContent("Acme's finding");
    });

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    // Either refetched or blank — what it must not be is the other tenant's
    // row, still painted, with nothing behind it in the cache.
    await waitFor(() => {
      expect(screen.getByTestId('probe-findings')).not.toHaveTextContent("Acme's finding");
    });
  });
});
