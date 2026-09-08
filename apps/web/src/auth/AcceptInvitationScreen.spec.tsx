import { ERROR_CODES } from '@sentinel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { AcceptInvitationScreen } from './AcceptInvitationScreen';
import { authTree, pendingClient, renderAuth, stubClient } from './render-helpers';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
});

const MEMBERSHIP = {
  id: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ9',
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  user: {
    id: 'usr_01M0T74WZZFY9T2QS56RGF3GQ8',
    email: 'invitee@acme.test',
    name: null,
  },
  roleKey: 'MEMBER',
  status: 'ACTIVE',
  createdAt: '2026-09-08T09:00:00.000Z',
  updatedAt: '2026-09-08T09:00:00.000Z',
};

/** The 401 an unauthenticated caller gets: `AuthenticationGuard` runs before
 *  `CsrfGuard` (`app.module.ts`), so a signed-out visitor is refused for the
 *  reason this screen has to act on, not for a missing CSRF token. */
function unauthenticated(): never {
  throw new ApiError({
    kind: 'api',
    status: 401,
    code: ERROR_CODES.UNAUTHENTICATED,
    message: 'Sign in to continue.',
    requestId: 'req_01JANON',
  });
}

describe('AcceptInvitationScreen — the four required states', () => {
  it('EMPTY: a link with no token says so and asks for nothing', () => {
    const { client, requests } = stubClient(() => MEMBERSHIP);
    renderAuth(<AcceptInvitationScreen token={null} />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This link is incomplete' }),
    ).toBeInTheDocument();
    // Nothing is requested when there is nothing to redeem, and nobody is sent
    // to sign in for a link that would fail anyway.
    expect(requests).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('EMPTY: an empty token is the same state as no token at all', () => {
    const { client, requests } = stubClient(() => MEMBERSHIP);
    renderAuth(<AcceptInvitationScreen token="" />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This link is incomplete' }),
    ).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('LOADING: submits on load and shows a skeleton while it waits', async () => {
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, pendingClient());

    expect(
      screen.getByRole('heading', { level: 1, name: 'Accepting your invitation' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Accepting your invitation.')).toBeInTheDocument();
    });
  });

  it('SUCCESS: posts the token alone and confirms the membership it created', async () => {
    const { client, requests } = stubClient(() => MEMBERSHIP);
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' }),
    ).toBeInTheDocument();

    // The body carries the token and NOTHING else — `acceptInvitationRequestSchema`
    // is `.strict()` and deliberately has no address field, because the server
    // compares the invited address to the authenticated user's.
    expect(requests).toEqual([
      { method: 'POST', path: '/api/v1/invitations/accept', body: { token: 'tok_abc' } },
    ]);

    // The role comes from the membership the API returned, not from anything
    // this screen assumed.
    expect(screen.getByRole('status')).toHaveTextContent('MEMBER');
  });

  it('SUCCESS: says the active organisation has NOT changed', async () => {
    const { client } = stubClient(() => MEMBERSHIP);
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);
    await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' });

    // `POST /invitations/accept` creates a membership and nothing else; the
    // session goes on acting in whatever organisation it was already in. A
    // screen that implied otherwise would send the user looking for data that
    // is not on their screen.
    expect(screen.getByRole('status')).toHaveTextContent(/has not changed/i);
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('ERROR: renders the API message and the request ID, and invents no token story', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.TOKEN_INVALID,
        message: 'That invitation link cannot be used.',
        requestId: 'req_01JINVITE',
      });
    });
    renderAuth(<AcceptInvitationScreen token="tok_spent" />, client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not accept that invitation' }),
    ).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That invitation link cannot be used.');
    expect(alert).toHaveTextContent('req_01JINVITE');

    // THE ASSERTION THAT MATTERS. The API answers ONE 422 with ONE message for
    // unknown, expired, revoked, already accepted, superseded, and issued to
    // somebody else — deliberately, so the endpoint is not an oracle for
    // whether a token exists. Copy on this screen that guessed at which of
    // those happened would rebuild the oracle in the client.
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/expired|revoked|already accepted|someone else|somebody else/i);
  });

  it('ERROR: a 409 renders the same way, through the same components', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 409,
        code: ERROR_CODES.DUPLICATE_RESOURCE,
        message: 'You are already a member of that organisation.',
        requestId: 'req_01JDUPE',
      });
    });
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You are already a member of that organisation.');
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('AcceptInvitationScreen — a signed-out invitee is brought back to THIS link', () => {
  it('redirects to the login href carrying this path and this token', async () => {
    const { client } = stubClient(unauthenticated);
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);

    // Exactly the href `loginHrefForDestination` builds: the destination is
    // path + query, so the token survives the round trip and the invitee lands
    // back on a link that still works. This is the first real caller of the
    // mechanism Task 16 built.
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        '/login?next=%2Faccept-invitation%3Ftoken%3Dtok_abc',
      );
    });

    // And the same href is on screen, so an invitee whose navigation did not
    // happen is not stranded on a card with nothing to click.
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Faccept-invitation%3Ftoken%3Dtok_abc',
    );
  });

  it('a token needing escaping is encoded rather than smuggled into the query', async () => {
    const { client } = stubClient(unauthenticated);
    renderAuth(<AcceptInvitationScreen token="a&next=/evil" />, client);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        '/login?next=%2Faccept-invitation%3Ftoken%3Da%2526next%253D%252Fevil',
      );
    });
  });

  it('treats SESSION_EXPIRED the same as UNAUTHENTICATED', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.SESSION_EXPIRED,
        message: 'Your session has ended.',
        requestId: 'req_02',
      });
    });
    renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        '/login?next=%2Faccept-invitation%3Ftoken%3Dtok_abc',
      );
    });
  });
});

describe('AcceptInvitationScreen — the token is consumed exactly once', () => {
  it('fires exactly one request under StrictMode, which mounts twice', async () => {
    // THE CASE THE REF GUARD EXISTS FOR, reproduced the way
    // `VerifyEmailScreen.spec.tsx` records it has to be: a remount, not a
    // re-render. An invitation token is single-use in exactly the way a
    // verification token is — the second call would consume nothing, answer
    // TOKEN_INVALID, and report a failure for an acceptance that succeeded.
    const { client, requests } = stubClient(() => MEMBERSHIP);
    render(<StrictMode>{authTree(<AcceptInvitationScreen token="tok_abc" />, client)}</StrictMode>);

    await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' });
    expect(requests).toHaveLength(1);
  });

  it('does not fire a second request when the component merely re-renders', async () => {
    const { client, requests } = stubClient(() => MEMBERSHIP);
    const { rerender } = renderAuth(<AcceptInvitationScreen token="tok_abc" />, client);
    await screen.findByRole('heading', { level: 1, name: 'Invitation accepted' });

    rerender(authTree(<AcceptInvitationScreen token="tok_abc" />, client));
    rerender(authTree(<AcceptInvitationScreen token="tok_abc" />, client));

    expect(requests).toHaveLength(1);
  });
});
