import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { pendingClient, renderApp, stubClient, type RecordedRequest } from '../app/render-helpers';
import { SessionsPanel } from './SessionsPanel';

const CURRENT = 'ses_01M0T74WZZFY9T2QS56RGF3GQ7';
const OTHER = 'ses_01M0T74WZZFY9T2QS56RGF3GQ8';

const row = (id: string, current: boolean, userAgent: string | null, ip: string | null) => ({
  id,
  ip,
  userAgent,
  createdAt: '2026-09-01T10:00:00Z',
  lastSeenAt: '2026-09-07T09:00:00Z',
  current,
});

const page = (rows: unknown[], hasMore = false) => ({
  data: rows,
  pagination: { nextCursor: hasMore ? 'cursor' : null, hasMore, limit: 50 },
});

function responder(rows: unknown[]): (request: RecordedRequest) => unknown {
  return (request) => {
    if (request.method === 'GET') return page(rows);
    if (request.path === '/api/v1/auth/sessions') {
      return { status: 'SESSIONS_REVOKED', revoked: 2 };
    }
    return { status: 'SESSION_REVOKED' };
  };
}

describe('SessionsPanel — the required states', () => {
  it('LOADING: a skeleton, not a spinner', () => {
    renderApp(<SessionsPanel />, pendingClient());
    expect(screen.getByTestId('sessions-skeleton')).toBeInTheDocument();
  });

  it('SUCCESS: renders each session with its address, agent and both timestamps', async () => {
    const { client } = stubClient(
      responder([
        row(CURRENT, true, 'Firefox on Linux', '203.0.113.9'),
        row(OTHER, false, 'Safari on iOS', '198.51.100.4'),
      ]),
    );
    renderApp(<SessionsPanel />, client);

    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.9/)).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.4/)).toBeInTheDocument();
  });

  it('marks the current session, and marks exactly one', async () => {
    const { client } = stubClient(
      responder([
        row(CURRENT, true, 'Firefox on Linux', '203.0.113.9'),
        row(OTHER, false, 'Safari on iOS', '198.51.100.4'),
      ]),
    );
    renderApp(<SessionsPanel />, client);

    expect(await screen.findAllByText('This device')).toHaveLength(1);
  });

  it('says so plainly when no address or agent was recorded', async () => {
    const { client } = stubClient(responder([row(CURRENT, true, null, null)]));
    renderApp(<SessionsPanel />, client);

    // `null` means "not recorded" rather than "not applicable"
    // (conventions.md §4), and an empty cell would say neither.
    expect(await screen.findByText('Unrecorded device')).toBeInTheDocument();
    expect(screen.getByText(/No address recorded/)).toBeInTheDocument();
  });

  it('ERROR: explains and offers a retry', async () => {
    const { client } = stubClient(() => {
      throw new Error('boom');
    });
    renderApp(<SessionsPanel />, client);

    expect(await screen.findByText(/sessions could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders a user agent as text rather than as markup', async () => {
    // `User-Agent` is the one column in the Session table an attacker chooses
    // outright. `session.service.ts` caps its length and says in terms that the
    // escaping "is still owed by whatever renders it" — this is that renderer.
    const hostile = '<img src=x onerror="alert(1)">';
    const { client } = stubClient(responder([row(CURRENT, true, hostile, '203.0.113.9')]));
    const { container } = renderApp(<SessionsPanel />, client);

    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('SessionsPanel — revoking', () => {
  it('sends a DELETE for the session whose button was pressed', async () => {
    const { client, requests } = stubClient(
      responder([
        row(CURRENT, true, 'Firefox on Linux', '203.0.113.9'),
        row(OTHER, false, 'Safari on iOS', '198.51.100.4'),
      ]),
    );
    renderApp(<SessionsPanel />, client);

    await screen.findByText('Safari on iOS');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.method === 'DELETE' && request.path === `/api/v1/auth/sessions/${OTHER}`,
        ),
      ).toBe(true);
    });
  });

  it('labels the current session differently, so it is not signed out by accident', async () => {
    const { client } = stubClient(
      responder([
        row(CURRENT, true, 'Firefox on Linux', '203.0.113.9'),
        row(OTHER, false, 'Safari on iOS', '198.51.100.4'),
      ]),
    );
    renderApp(<SessionsPanel />, client);

    await screen.findByText('Firefox on Linux');
    expect(screen.getByRole('button', { name: 'Sign out this device' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });

  it('asks before signing out every other device, and only then sends the bulk DELETE', async () => {
    const { client, requests } = stubClient(
      responder([
        row(CURRENT, true, 'Firefox on Linux', '203.0.113.9'),
        row(OTHER, false, 'Safari on iOS', '198.51.100.4'),
      ]),
    );
    renderApp(<SessionsPanel />, client);

    await screen.findByText('Safari on iOS');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out all other devices' }));

    // The confirmation step is real: nothing has been sent yet.
    expect(
      requests.filter(
        (request) => request.method === 'DELETE' && request.path === '/api/v1/auth/sessions',
      ),
    ).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Yes, sign the others out' }));

    await waitFor(() => {
      expect(
        requests.filter(
          (request) => request.method === 'DELETE' && request.path === '/api/v1/auth/sessions',
        ),
      ).toHaveLength(1);
    });
    expect(await screen.findByText(/Signed out 2 other devices/)).toBeInTheDocument();
  });

  it('says nothing happened when there was nothing to sign out', async () => {
    const { client } = stubClient((request) => {
      if (request.method === 'GET') return page([row(CURRENT, true, 'Firefox', '203.0.113.9')]);
      return { status: 'SESSIONS_REVOKED', revoked: 0 };
    });
    renderApp(<SessionsPanel />, client);

    await screen.findByText('Firefox');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out all other devices' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, sign the others out' }));

    expect(await screen.findByText(/no other devices to sign out/)).toBeInTheDocument();
  });

  it('says the list is truncated rather than pretending it is complete', async () => {
    const { client } = stubClient((request) => {
      if (request.method === 'GET') return page([row(CURRENT, true, 'Firefox', null)], true);
      return { status: 'SESSION_REVOKED' };
    });
    renderApp(<SessionsPanel />, client);

    expect(await screen.findByText(/Only the 50 most recently used/)).toBeInTheDocument();
  });
});
