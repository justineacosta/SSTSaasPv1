import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import type { MfaChallenge } from './MfaChallengeProvider';
import { MfaScreen } from './MfaScreen';
import { pendingClient, renderAuth, renderAuthWithChallenge, stubClient } from './render-helpers';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const CHALLENGE: MfaChallenge = { pendingToken: 'pending-abc', redirectTo: '/assets' };

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
});

describe('MfaScreen — the four required states', () => {
  it('EMPTY: with no challenge in memory, explains why and offers the way back', () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuth(<MfaScreen />, client);

    expect(screen.getByRole('heading', { level: 1, name: 'Start again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('LOADING: disables submit while verifying', async () => {
    renderAuthWithChallenge(<MfaScreen />, pendingClient(), CHALLENGE);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Verifying…' })).toBeDisabled();
    });
  });

  it('ERROR: shows the message and the request ID, and keeps the code entered', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.MFA_INVALID,
        message: 'That code is not valid.',
        requestId: 'req_01JMFA',
      });
    });
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That code is not valid.');
    expect(alert).toHaveTextContent('req_01JMFA');
    expect(screen.getByLabelText('Authentication code')).toHaveValue('000000');
  });

  it('SUCCESS: sends the pending token with the code and returns to the destination', async () => {
    const { client, requests } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/assets');
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/mfa/verify',
        body: { pendingToken: 'pending-abc', code: '123456' },
      },
    ]);
  });
});

describe('MfaScreen — one screen, two kinds of code', () => {
  it('starts in TOTP mode with the one-time-code attributes', () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const input = screen.getByLabelText('Authentication code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('maxlength', '6');
  });

  it('switching to a recovery code changes the label AND the input attributes', async () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));

    const input = screen.getByLabelText('Recovery code');
    // A recovery code is not numeric and no platform will autofill one. A
    // numeric keypad in front of it is a user who cannot type their way out of
    // a lost phone.
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).not.toHaveAttribute('maxlength');
  });

  it('clears a code typed in the other mode when switching', async () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    expect(screen.getByLabelText('Recovery code')).toHaveValue('');
  });

  it('sends a recovery code to the same endpoint', async () => {
    const { client, requests } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), 'abcd-efgh-ijkl');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/assets');
    });
    expect(requests[0]?.body).toEqual({
      pendingToken: 'pending-abc',
      code: 'abcd-efgh-ijkl',
    });
  });

  it('can switch back to the authenticator app', async () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.click(screen.getByRole('button', { name: 'Use my authenticator app instead' }));
    expect(screen.getByLabelText('Authentication code')).toHaveAttribute('inputmode', 'numeric');
  });
});

describe('MfaScreen — the pending token is never rendered as readable text', () => {
  it('keeps it in a hidden input and out of the visible document', () => {
    const { client } = stubClient(() => ({ status: 'AUTHENTICATED' }));
    const { container } = renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    expect(document.body.textContent ?? '').not.toContain('pending-abc');
    const hidden = container.querySelector('input[type="hidden"]');
    expect(hidden).toHaveValue('pending-abc');
  });
});

describe('MfaScreen — server field errors', () => {
  it('lands an error for `code` on the code input with aria-describedby intact', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request body failed validation.',
        requestId: 'req_01JCODE',
        fieldErrors: [{ path: 'code', code: 'too_small', message: 'Enter all six digits.' }],
      });
    });
    renderAuthWithChallenge(<MfaScreen />, client, CHALLENGE);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Authentication code'), '12345');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    const input = screen.getByLabelText('Authentication code');
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(
      'Enter all six digits.',
    );
  });
});
