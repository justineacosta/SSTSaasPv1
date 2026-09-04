import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { pendingClient, renderAuth, stubClient } from './render-helpers';
import { ResetPasswordScreen } from './ResetPasswordScreen';

async function setPassword(password: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('New password'), password);
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
}

describe('ResetPasswordScreen — the four required states', () => {
  it('EMPTY: a link with no token says so and points at a fresh one', () => {
    const { client, requests } = stubClient(() => ({ status: 'PASSWORD_RESET' }));
    renderAuth(<ResetPasswordScreen token={null} />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'This link is incomplete' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(requests).toEqual([]);
  });

  it('LOADING: disables submit while saving', async () => {
    renderAuth(<ResetPasswordScreen token="tok_abc" />, pendingClient());
    await setPassword('correct horse battery');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    });
  });

  it('ERROR: an expired token shows the message and the request ID', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.TOKEN_INVALID,
        message: 'That reset link is no longer valid.',
        requestId: 'req_01JRESET',
      });
    });
    renderAuth(<ResetPasswordScreen token="tok_expired" />, client);
    await setPassword('correct horse battery');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That reset link is no longer valid.');
    expect(alert).toHaveTextContent('req_01JRESET');
    // forms.md §1 rule 2 — the entered password survives the failure.
    expect(screen.getByLabelText('New password')).toHaveValue('correct horse battery');
  });

  it('SUCCESS: confirms and sends the token with the new password', async () => {
    const { client, requests } = stubClient(() => ({ status: 'PASSWORD_RESET' }));
    renderAuth(<ResetPasswordScreen token="tok_abc" />, client);
    await setPassword('correct horse battery');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Password changed' }),
    ).toBeInTheDocument();
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/reset-password',
        body: { token: 'tok_abc', password: 'correct horse battery' },
      },
    ]);
  });
});

describe('ResetPasswordScreen — the password field', () => {
  it('declares new-password so a manager offers to generate, not to fill', () => {
    const { client } = stubClient(() => ({ status: 'PASSWORD_RESET' }));
    renderAuth(<ResetPasswordScreen token="tok_abc" />, client);
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('reveals and re-hides the password on the toggle', async () => {
    const { client } = stubClient(() => ({ status: 'PASSWORD_RESET' }));
    renderAuth(<ResetPasswordScreen token="tok_abc" />, client);

    const user = userEvent.setup();
    const input = screen.getByLabelText('New password');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
  });

  it('enforces the contract password floor before any request leaves', async () => {
    const { client, requests } = stubClient(() => ({ status: 'PASSWORD_RESET' }));
    renderAuth(<ResetPasswordScreen token="tok_abc" />, client);
    await setPassword('short');

    await waitFor(() => {
      expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    });
    expect(requests).toEqual([]);
  });
});
