import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Permission } from '@sentinel/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { renderApp, stubClient, testQueryClient, type RecordedRequest } from './render-helpers';
import { SESSION_QUERY_KEY, SessionContextProvider } from './session-context';

const USER_ID = 'usr_01M0T74WZZFY9T2QS56RGF3GQ8';
const ORG_A = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';
const ORG_B = 'org_01M0T74WZZFY9T2QS56RGF3GQ9';

const organization = (id: string, slug: string, name: string) => ({
  id,
  slug,
  name,
  status: 'ACTIVE' as const,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});

const PERMISSIONS: Permission[] = ['organization.read'];

const sessionOn = (id: string, slug: string, name: string) => ({
  userId: USER_ID,
  activeOrganization: { id, slug, name },
  permissions: PERMISSIONS,
  entitlements: {},
});

function respond(request: RecordedRequest): unknown {
  if (request.path === '/api/v1/organizations') {
    return {
      data: [organization(ORG_A, 'acme', 'Acme'), organization(ORG_B, 'globex', 'Globex')],
      pagination: { nextCursor: null, hasMore: false, limit: 50 },
    };
  }
  if (request.path === '/api/v1/auth/switch-org') {
    const body = request.body as { organizationId: string };
    return body.organizationId === ORG_B
      ? sessionOn(ORG_B, 'globex', 'Globex')
      : sessionOn(ORG_A, 'acme', 'Acme');
  }
  throw new Error(`unexpected request: ${request.method} ${request.path}`);
}

function tree(id: string, slug: string, name: string): ReactNode {
  return (
    <SessionContextProvider session={sessionOn(id, slug, name)}>
      <OrganizationSwitcher />
    </SessionContextProvider>
  );
}

describe('OrganizationSwitcher — switching clears the cache entirely', () => {
  it('DROPS DATA CACHED UNDER THE PREVIOUS ORGANISATION', async () => {
    // THE TEST THIS COMPONENT EXISTS FOR. `architecture/frontend.md` §3:
    // "Switching organisations clears the cache entirely — a stale cross-tenant
    // render would be a security-visible bug even though the data was
    // legitimately fetched." The assertion is against the cache itself rather
    // than against what happens to be on screen, because a component that
    // merely re-rendered would pass the visual version of this test while
    // leaving Tenant A's rows in memory for the next mount to serve.
    const queryClient = testQueryClient();
    queryClient.setQueryData(
      ['org', ORG_A, 'findings'],
      [{ id: 'fnd_a', title: "Acme's finding" }],
    );
    queryClient.setQueryData(['org', ORG_A, 'members'], [{ id: 'mbr_a' }]);

    const { client } = stubClient(respond);
    renderApp(tree(ORG_A, 'acme', 'Acme'), client, queryClient);

    const select = await screen.findByLabelText('Organisation');
    await userEvent.selectOptions(select, ORG_B);

    await waitFor(() => {
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({
        activeOrganization: { id: ORG_B },
      });
    });

    expect(queryClient.getQueryData(['org', ORG_A, 'findings'])).toBeUndefined();
    expect(queryClient.getQueryData(['org', ORG_A, 'members'])).toBeUndefined();
  });

  it('drops cached data that is NOT organisation-keyed either', async () => {
    // The reason `clear()` is right and a prefix-based invalidation is not: a
    // key that never named an organisation still holds that organisation's
    // data, and no naming convention makes "did I list them all" checkable.
    const queryClient = testQueryClient();
    queryClient.setQueryData(['sessions'], { data: [] });
    queryClient.setQueryData(['some-future-feature'], { rows: ['tenant A data'] });

    const { client } = stubClient(respond);
    renderApp(tree(ORG_A, 'acme', 'Acme'), client, queryClient);

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    await waitFor(() => {
      expect(queryClient.getQueryData(['some-future-feature'])).toBeUndefined();
    });
    expect(queryClient.getQueryData(['sessions'])).toBeUndefined();
  });

  it('leaves the NEW session document in place, not swept away by its own switch', async () => {
    // Ordering matters, and after review finding C-4 the ordering is the other
    // way round: the session is seeded first and then excluded from the reset
    // by hash. What must hold either way is this assertion — the document the
    // switch just produced is the one in the cache when the dust settles. Get
    // it wrong and the shell falls back to a skeleton on every switch.
    const queryClient = testQueryClient();
    const { client } = stubClient(respond);
    renderApp(tree(ORG_A, 'acme', 'Acme'), client, queryClient);

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    await waitFor(() => {
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({
        activeOrganization: { id: ORG_B, slug: 'globex' },
      });
    });
  });

  it('posts to switch-org with the chosen id and nothing else', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(tree(ORG_A, 'acme', 'Acme'), client);

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_B);

    await waitFor(() => {
      expect(requests.some((request) => request.path === '/api/v1/auth/switch-org')).toBe(true);
    });
    const call = requests.find((request) => request.path === '/api/v1/auth/switch-org');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ organizationId: ORG_B });
  });

  it('does not call the API when the chosen organisation is the current one', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(tree(ORG_A, 'acme', 'Acme'), client);

    await userEvent.selectOptions(await screen.findByLabelText('Organisation'), ORG_A);

    expect(requests.filter((request) => request.path === '/api/v1/auth/switch-org')).toHaveLength(
      0,
    );
  });
});

describe('OrganizationSwitcher — its own states', () => {
  it('LOADING: a skeleton rather than an empty select', () => {
    const client = {
      request: () =>
        new Promise<never>(() => {
          /* never settles */
        }),
    };
    renderApp(tree(ORG_A, 'acme', 'Acme'), client);
    expect(screen.getByTestId('organizations-skeleton')).toBeInTheDocument();
  });

  it('EMPTY: explains what an organisation is and how one is joined', async () => {
    const { client } = stubClient(() => ({
      data: [],
      pagination: { nextCursor: null, hasMore: false, limit: 50 },
    }));
    renderApp(tree(ORG_A, 'acme', 'Acme'), client);

    expect(await screen.findByText(/do not belong to an organisation yet/)).toBeInTheDocument();
  });

  it('ERROR: says so rather than rendering a control that cannot work', async () => {
    const { client } = stubClient(() => {
      throw new Error('boom');
    });
    renderApp(tree(ORG_A, 'acme', 'Acme'), client);

    expect(await screen.findByText(/organisations could not be loaded/)).toBeInTheDocument();
  });
});
