import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { authTree, pendingClient, renderAuth, stubClient } from './render-helpers';
import { VerifyEmailScreen } from './VerifyEmailScreen';

describe('VerifyEmailScreen — the four required states', () => {
  it('LOADING: submits on load and shows a skeleton while it waits', async () => {
    renderAuth(<VerifyEmailScreen token="tok_abc" />, pendingClient());

    expect(
      screen.getByRole('heading', { level: 1, name: 'Verifying your email' }),
    ).toBeInTheDocument();
    // A skeleton matching the final layout, and an aria-busy live region, not a
    // bare spinner. frontend.md §6.
    await waitFor(() => {
      expect(screen.getByText('Verifying your email address.')).toBeInTheDocument();
    });
  });

  it('SUCCESS: confirms and offers sign-in', async () => {
    const { client, requests } = stubClient(() => ({ status: 'EMAIL_VERIFIED' }));
    renderAuth(<VerifyEmailScreen token="tok_abc" />, client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Email verified' }),
    ).toBeInTheDocument();
    expect(requests).toEqual([
      { method: 'POST', path: '/api/v1/auth/verify-email', body: { token: 'tok_abc' } },
    ]);
  });

  it('EMPTY: a link with no token at all says so and offers a resend', () => {
    const { client, requests } = stubClient(() => ({ status: 'VERIFICATION_REQUIRED' }));
    renderAuth(<VerifyEmailScreen token={null} />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This link is incomplete' }),
    ).toBeInTheDocument();
    // Nothing is requested when there is nothing to verify.
    expect(requests).toEqual([]);
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeInTheDocument();
  });

  it('ERROR: a rejected token shows the message, the request ID, and a resend form', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.TOKEN_INVALID,
        message: 'That link is no longer valid.',
        requestId: 'req_01JVERIFY',
      });
    });
    renderAuth(<VerifyEmailScreen token="tok_expired" />, client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not verify that link' }),
    ).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That link is no longer valid.');
    expect(alert).toHaveTextContent('req_01JVERIFY');
    expect(screen.getByLabelText('Work email')).toBeInTheDocument();
  });
});

describe('VerifyEmailScreen — the token is consumed exactly once', () => {
  it('does not fire a second request when the component re-renders', async () => {
    const { client, requests } = stubClient(() => ({ status: 'EMAIL_VERIFIED' }));
    const { rerender } = renderAuth(<VerifyEmailScreen token="tok_abc" />, client);
    await screen.findByRole('heading', { level: 1, name: 'Email verified' });

    // The whole tree, providers included: `rerender` replaces the root element,
    // so re-rendering the bare screen would unmount the providers under it.
    rerender(authTree(<VerifyEmailScreen token="tok_abc" />, client));
    rerender(authTree(<VerifyEmailScreen token="tok_abc" />, client));

    // A verification token is single-use. A second call would consume nothing
    // and answer TOKEN_INVALID, and the screen would report a failure for a
    // verification that actually succeeded — the exact defect the ref guard in
    // VerifyEmailScreen exists to prevent under React's StrictMode double-mount.
    expect(requests).toHaveLength(1);
  });
});

describe('VerifyEmailScreen — the resend affordance', () => {
  it('posts to resend-verification and answers without revealing the address exists', async () => {
    const { client, requests } = stubClient((request) => {
      if (request.path === '/api/v1/auth/verify-email') {
        throw new ApiError({
          kind: 'api',
          status: 422,
          code: ERROR_CODES.TOKEN_INVALID,
          message: 'That link is no longer valid.',
          requestId: 'req_01JVERIFY',
        });
      }
      return { status: 'VERIFICATION_REQUIRED' };
    });
    renderAuth(<VerifyEmailScreen token="tok_expired" />, client);
    await screen.findByLabelText('Work email');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Work email'), 'someone@acme.test');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('If that address needs verifying');
    // The message is conditional on nothing about the address. An enumeration
    // oracle built out of a helpful confirmation is still an enumeration oracle.
    expect(confirmation.textContent ?? '').not.toContain('someone@acme.test');
    expect(requests[1]).toEqual({
      method: 'POST',
      path: '/api/v1/auth/resend-verification',
      body: { email: 'someone@acme.test' },
    });
  });
});
