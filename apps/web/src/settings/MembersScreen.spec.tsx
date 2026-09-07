import { ERROR_CODES, type Permission } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
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

describe('MembersScreen — a 403 is a PERMISSION state, not an error state (review C-5)', () => {
  // REVIEW FINDING C-5. Both list routes carry
  // `@RequirePermission('organization.manage_members')` — `memberships.controller.ts:84`
  // and `invitations.controller.ts:211` — so a member without it gets 403 on
  // both. The screen used to render that as "The member list could not be
  // loaded. Try reloading the page." — advice that will fail identically
  // forever — underneath the sentence "You can see who belongs to this
  // organisation", which is false: the list it names is the one that just 403'd.
  //
  // `architecture/frontend.md` §6 requires a permission state that "explains the
  // missing permission rather than showing a blank page", and §5 requires the UI
  // to say why an action is unavailable and who can grant it.

  const forbidden = () => {
    throw new ApiError({
      kind: 'api',
      status: 403,
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'You do not have permission to perform this action.',
      requestId: 'req_c5',
    });
  };

  it('names the missing permission and who can grant it, for BOTH lists', async () => {
    const { client } = stubClient(forbidden);
    renderApp(tree([]), client);

    const members = await screen.findByTestId('members-permission-state');
    expect(members).toHaveTextContent(/organization\.manage_members/);
    expect(members).toHaveTextContent(/owner or admin can grant/);

    const invitations = await screen.findByTestId('invitations-permission-state');
    expect(invitations).toHaveTextContent(/organization\.manage_members/);
    expect(invitations).toHaveTextContent(/owner or admin can grant/);
  });

  it('does NOT tell the user to reload, because reloading will 403 forever', async () => {
    const { client } = stubClient(forbidden);
    renderApp(tree([]), client);

    await screen.findByTestId('members-permission-state');
    await screen.findByTestId('invitations-permission-state');
    expect(screen.queryByText(/Try reloading the page/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it('does NOT claim the user can see who belongs to this organisation', async () => {
    // The false sentence, asserted as absent. It was rendered two lines under
    // the alert reporting the 403 on the very list it referred to.
    const { client } = stubClient(forbidden);
    renderApp(tree([]), client);

    await screen.findByTestId('members-permission-state');
    expect(
      screen.queryByText(/You can see who belongs to this organisation/),
    ).not.toBeInTheDocument();
  });

  it('still renders an ERROR state for a failure that is NOT a 403', async () => {
    // The discrimination has to keep both branches. A transient failure is
    // exactly where "try again" is the right advice, and a permission state
    // there would be a different false sentence.
    const { client } = stubClient(() => {
      throw new ApiError({ kind: 'network', message: 'Could not reach the Sentinel API.' });
    });
    renderApp(tree(['organization.manage_members', 'organization.manage_roles']), client);

    expect(await screen.findByText(/member list could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByTestId('members-permission-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invitations-permission-state')).not.toBeInTheDocument();
  });
});
