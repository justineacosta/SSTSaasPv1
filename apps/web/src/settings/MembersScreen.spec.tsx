import type { Permission } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderApp, stubClient, type RecordedRequest } from '../app/render-helpers';
import { SessionContextProvider } from '../app/session-context';
import { MembersScreen } from './MembersScreen';

const USER_ID = 'usr_01M0T74WZZFY9T2QS56RGF3GQ8';
const ORG_ID = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';
const MEMBERSHIP_ID = 'mbr_01M0T74WZZFY9T2QS56RGF3GQ7';
const INVITATION_ID = 'inv_01M0T74WZZFY9T2QS56RGF3GQ7';

const member = {
  id: MEMBERSHIP_ID,
  organizationId: ORG_ID,
  user: { id: USER_ID, email: 'analyst@acme.test', name: 'Ana Lyst' },
  roleKey: 'MEMBER' as const,
  status: 'ACTIVE' as const,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const invitation = {
  id: INVITATION_ID,
  organizationId: ORG_ID,
  email: 'newcomer@acme.test',
  roleKey: 'MEMBER' as const,
  invitedByUserId: USER_ID,
  expiresAt: '2026-09-14T00:00:00Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
};

function respond(request: RecordedRequest): unknown {
  if (request.path.endsWith('/members') && request.method === 'GET') {
    return { data: [member], pagination: { nextCursor: null, hasMore: false, limit: 50 } };
  }
  if (request.path.endsWith('/invitations') && request.method === 'GET') {
    return { data: [invitation], pagination: { nextCursor: null, hasMore: false, limit: 50 } };
  }
  if (request.path.endsWith('/invitations') && request.method === 'POST') return invitation;
  if (request.method === 'PATCH') return { ...member, roleKey: 'ADMIN' };
  if (request.method === 'DELETE') return undefined;
  throw new Error(`unexpected request: ${request.method} ${request.path}`);
}

function tree(permissions: Permission[], withOrganization = true): ReactNode {
  return (
    <SessionContextProvider
      session={{
        userId: USER_ID,
        activeOrganization: withOrganization ? { id: ORG_ID, slug: 'acme', name: 'Acme' } : null,
        permissions,
        entitlements: {},
      }}
    >
      <MembersScreen />
    </SessionContextProvider>
  );
}

describe('MembersScreen — every affordance is gated on the permission set', () => {
  it('WITHOUT organization.manage_members: no invite form, no remove button, no revoke button', async () => {
    // THE GATING TEST. It is UX only — the API refuses each of these calls with
    // 403 PERMISSION_DENIED whether or not the button is drawn — but a UI that
    // offers an action the user cannot take is a support ticket, and one that
    // draws it and withdraws it is the flash of forbidden UI frontend.md §2
    // bans.
    const { client } = stubClient(respond);
    renderApp(tree(['organization.read']), client);

    await screen.findByText('analyst@acme.test');

    expect(screen.queryByRole('form', { name: 'Invite a member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('WITHOUT organization.manage_roles: the role is text, not a control', async () => {
    const { client } = stubClient(respond);
    renderApp(tree(['organization.read', 'organization.manage_members']), client);

    await screen.findByText('analyst@acme.test');
    expect(
      screen.queryByRole('combobox', { name: 'Role for analyst@acme.test' }),
    ).not.toBeInTheDocument();
    // `getAllByText`: the invitation row below also carries the role name, so
    // a `getByText` here fails on ambiguity rather than on the property.
    expect(screen.getAllByText('MEMBER').length).toBeGreaterThan(0);
  });

  it('WITH both permissions: the invite form, the role control and the remove button all render', async () => {
    const { client } = stubClient(respond);
    renderApp(
      tree(['organization.read', 'organization.manage_members', 'organization.manage_roles']),
      client,
    );

    await screen.findByText('analyst@acme.test');
    expect(
      screen.getByRole('combobox', { name: 'Role for analyst@acme.test' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('EXPLAINS the missing permission rather than leaving a blank space', async () => {
    // frontend.md §6's permission state: "explains the missing permission
    // rather than showing a blank page", and §5: the UI says why and who can
    // grant it.
    const { client } = stubClient(respond);
    renderApp(tree(['organization.read']), client);

    await screen.findByText('analyst@acme.test');
    expect(screen.getByText(/need organization\.manage_members/)).toBeInTheDocument();
    expect(
      screen.getByText(/Inviting somebody needs organization\.manage_members/),
    ).toBeInTheDocument();
    // Both panels say who can grant it, so there are deliberately two of these.
    expect(screen.getAllByText(/owner or admin can grant/)).toHaveLength(2);
  });
});

describe('MembersScreen — the writes', () => {
  it('PATCHes the membership when a role is changed', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(
      tree(['organization.read', 'organization.manage_members', 'organization.manage_roles']),
      client,
    );

    await screen.findByText('analyst@acme.test');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Role for analyst@acme.test' }),
      'ADMIN',
    );

    await waitFor(() => {
      const call = requests.find((request) => request.method === 'PATCH');
      expect(call?.path).toBe(`/api/v1/organizations/${ORG_ID}/members/${MEMBERSHIP_ID}`);
      expect(call?.body).toEqual({ roleKey: 'ADMIN' });
    });
  });

  it('asks before removing a member, and only then DELETEs', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(
      tree(['organization.read', 'organization.manage_members', 'organization.manage_roles']),
      client,
    );

    await screen.findByText('analyst@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.method === 'DELETE' &&
            request.path === `/api/v1/organizations/${ORG_ID}/members/${MEMBERSHIP_ID}`,
        ),
      ).toBe(true);
    });
  });

  it('POSTs an invitation with the address and role that were entered', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(tree(['organization.read', 'organization.manage_members']), client);

    await screen.findByRole('button', { name: 'Send invitation' });
    await userEvent.type(screen.getByLabelText('Email address'), 'newcomer@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => {
      const call = requests.find((request) => request.method === 'POST');
      expect(call?.path).toBe(`/api/v1/organizations/${ORG_ID}/invitations`);
      expect(call?.body).toEqual({ email: 'newcomer@acme.test', roleKey: 'MEMBER' });
    });
  });

  it('renders a server refusal the permission set did not predict', async () => {
    // Two refusals here come from inside the handler rather than from a guard,
    // so no permission set anticipates them: granting a role whose permissions
    // the caller lacks, and a write that would leave the organisation with no
    // owner (api/authorization.md §3's last three rows). A UI that only hides
    // things cannot explain a refusal it did not expect.
    const { client } = stubClient((request) => {
      if (request.method === 'PATCH') {
        throw new Error('You cannot grant a role that holds permissions you do not have.');
      }
      return respond(request);
    });
    renderApp(
      tree(['organization.read', 'organization.manage_members', 'organization.manage_roles']),
      client,
    );

    await screen.findByText('analyst@acme.test');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Role for analyst@acme.test' }),
      'OWNER',
    );

    expect(await screen.findByText(/cannot grant a role/)).toBeInTheDocument();
  });
});

describe('MembersScreen — with no active organisation', () => {
  it('EMPTY: says what is missing rather than listing nothing', () => {
    const { client } = stubClient(respond);
    renderApp(tree(['organization.read'], false), client);

    expect(screen.getByText(/not acting in an organisation yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });
});
