import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { ForgotPasswordScreen } from './ForgotPasswordScreen';
import { pendingClient, renderAuth, stubClient } from './render-helpers';

async function request(email: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
}

describe('ForgotPasswordScreen — the four required states', () => {
  it('EMPTY: a pristine, labelled form', () => {
    const { client } = stubClient(() => ({ status: 'RESET_REQUESTED' }));
    renderAuth(<ForgotPasswordScreen />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toHaveValue('');
  });

  it('LOADING: disables submit while sending', async () => {
    renderAuth(<ForgotPasswordScreen />, pendingClient());
    await request('someone@acme.test');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    });
  });

  it('ERROR: shows the message and the request ID', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 429,
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Too many requests. Try again shortly.',
        requestId: 'req_01JFORGOT',
      });
    });
    renderAuth(<ForgotPasswordScreen />, client);
    await request('someone@acme.test');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many requests. Try again shortly.');
    expect(alert).toHaveTextContent('req_01JFORGOT');
  });

  it('SUCCESS: confirms without saying whether the address exists', async () => {
    const { client, requests } = stubClient(() => ({ status: 'RESET_REQUESTED' }));
    renderAuth(<ForgotPasswordScreen />, client);
    await request('someone@acme.test');

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('If that address has a Sentinel account');
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/forgot-password',
        body: { email: 'someone@acme.test' },
      },
    ]);
  });
});

describe('ForgotPasswordScreen — enumeration resistance is the screen’s job too', () => {
  it('renders the identical confirmation for two different addresses', async () => {
    const texts: string[] = [];
    for (const address of ['registered@acme.test', 'nobody@nowhere.invalid']) {
      const { client } = stubClient(() => ({ status: 'RESET_REQUESTED' }));
      const { unmount } = renderAuth(<ForgotPasswordScreen />, client);
      await request(address);
      texts.push((await screen.findByRole('status')).textContent ?? '');
      unmount();
    }
    // The endpoint's whole contract is one constant status literal so that the
    // response cannot leak which addresses are registered. A screen that varied
    // its copy would hand that back.
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0] ?? '').not.toContain('registered@acme.test');
  });
});
