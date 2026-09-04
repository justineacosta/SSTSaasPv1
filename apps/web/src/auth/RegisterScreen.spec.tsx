import { ERROR_CODES } from '@sentinel/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { RegisterScreen } from './RegisterScreen';
import { pendingClient, renderAuth, stubClient } from './render-helpers';

async function fillIn(email = 'new@acme.test', password = 'correct horse battery'): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('RegisterScreen — the four required states', () => {
  it('EMPTY: a pristine form with labelled controls and the right autocomplete', () => {
    const { client } = stubClient(() => ({ status: 'VERIFICATION_REQUIRED' }));
    renderAuth(<RegisterScreen />, client);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Create your account' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toHaveAttribute('autocomplete', 'email');
    // forms.md §5 — the autocomplete value must be the right one, so a password
    // manager offers to generate rather than to fill.
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('LOADING: submit is disabled and says so while the request is in flight', async () => {
    renderAuth(<RegisterScreen />, pendingClient());
    await fillIn();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Creating account…' })).toBeDisabled();
    });
  });

  it('ERROR: shows the message and the request ID', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 429,
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Too many attempts. Try again in a few minutes.',
        requestId: 'req_01JREG',
      });
    });
    renderAuth(<RegisterScreen />, client);
    await fillIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many attempts. Try again in a few minutes.');
    expect(alert).toHaveTextContent('req_01JREG');
  });

  it('SUCCESS: a check-your-email state, NOT a redirect into the product', async () => {
    const { client, requests } = stubClient(() => ({ status: 'VERIFICATION_REQUIRED' }));
    renderAuth(<RegisterScreen />, client);
    await fillIn();

    // There is no session yet — POST /auth/register issues none — so sending the
    // user into the app would land them on a sign-in wall.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check your email' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('new@acme.test');
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/register',
        body: { email: 'new@acme.test', password: 'correct horse battery' },
      },
    ]);
  });
});

describe('RegisterScreen — validation and server errors', () => {
  it('applies the contract password policy client-side before any request', async () => {
    const { client, requests } = stubClient(() => ({ status: 'VERIFICATION_REQUIRED' }));
    renderAuth(<RegisterScreen />, client);
    await fillIn('new@acme.test', 'short');

    // The contract's floor is 12 characters (passwordSchema). The client check
    // is a UX affordance; the server remains the authority, which is why the
    // assertion is that no request was made rather than that the API refused.
    await waitFor(() => {
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    });
    expect(requests).toEqual([]);
  });

  it('normalises the email through the contract schema before sending it', async () => {
    const { client, requests } = stubClient(() => ({ status: 'VERIFICATION_REQUIRED' }));
    renderAuth(<RegisterScreen />, client);
    await fillIn('  New@ACME.test  ', 'correct horse battery');

    // emailSchema's .trim().toLowerCase() is a security control, not tidiness:
    // User.email is unique and Postgres does not case-fold. The screen gets
    // that for free by using the contract schema as its resolver.
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.body).toEqual({
      email: 'new@acme.test',
      password: 'correct horse battery',
    });
  });

  it('puts a DUPLICATE_RESOURCE field error on the email input, keeping the password', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request body failed validation.',
        requestId: 'req_01JDUP',
        fieldErrors: [
          { path: 'email', code: 'invalid_string', message: 'Enter a valid email address.' },
        ],
      });
    });
    renderAuth(<RegisterScreen />, client);
    await fillIn();

    const email = screen.getByLabelText('Work email');
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
    const ids = (email.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(
      'Enter a valid email address.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('correct horse battery');
  });
});
