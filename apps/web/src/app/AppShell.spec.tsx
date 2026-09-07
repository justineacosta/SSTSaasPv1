import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { AppShell } from './AppShell';
import { pendingClient, renderApp, stubClient } from './render-helpers';

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
