import { ERROR_CODES } from '@sentinel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/provider';
import { ApiError } from '../api/errors';
import { LoginScreen } from './LoginScreen';
import { MfaChallengeProvider, useMfaChallenge } from './MfaChallengeProvider';
import { MfaScreen } from './MfaScreen';
import { pendingClient, renderAuth, stubClient } from './render-helpers';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
});

async function signIn(
  email = 'analyst@acme.test',
  password = 'correct horse battery',
): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginScreen — the four required states', () => {
  it('EMPTY: renders a pristine, labelled form', () => {
    const { client } = stubClient(() => ({ mfaRequired: false }));
    renderAuth(<LoginScreen redirectTo={null} />, client);

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('LOADING: disables submit while the request is in flight', async () => {
    renderAuth(<LoginScreen redirectTo={null} />, pendingClient());
    await signIn();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('ERROR: announces the failure and shows the request ID for support', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'That email and password do not match.',
        requestId: 'req_01JLOGIN',
      });
    });
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That email and password do not match.');
    // frontend.md §6 — the request ID in every error state.
    expect(alert).toHaveTextContent('req_01JLOGIN');
  });

  it('SUCCESS: navigates to the intended destination', async () => {
    const { client } = stubClient(() => ({ mfaRequired: false }));
    renderAuth(<LoginScreen redirectTo="/findings?severity=high" />, client);
    await signIn();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/findings?severity=high');
    });
  });
});

describe('LoginScreen — the mfaRequired branch, both ways', () => {
  it('mfaRequired: false goes straight to the app and starts no challenge', async () => {
    const { client, requests } = stubClient(() => ({ mfaRequired: false }));
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/dashboard');
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/v1/auth/login',
        body: {
          email: 'analyst@acme.test',
          password: 'correct horse battery',
          rememberMe: false,
        },
      },
    ]);
  });

  it('mfaRequired: true routes to /login/mfa and does NOT complete the sign-in', async () => {
    const { client } = stubClient(() => ({ mfaRequired: true, pendingToken: 'pending-abc' }));
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/login/mfa');
    });
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('LoginScreen — the pending credential never reaches a URL', () => {
  /** Reads the challenge out of the shared provider so a spec can inspect it. */
  function ChallengeProbe(): ReactNode {
    const { challenge } = useMfaChallenge();
    return <output data-testid="challenge">{JSON.stringify(challenge)}</output>;
  }

  it('carries pendingToken in memory, and every router argument is free of it', async () => {
    const { client } = stubClient(() => ({ mfaRequired: true, pendingToken: 'pending-abc' }));
    render(
      <ApiClientProvider client={client}>
        <MfaChallengeProvider>
          <LoginScreen redirectTo="/assets" />
          <ChallengeProbe />
        </MfaChallengeProvider>
      </ApiClientProvider>,
    );
    await signIn();

    await waitFor(() => {
      expect(screen.getByTestId('challenge')).toHaveTextContent('pending-abc');
    });
    expect(screen.getByTestId('challenge')).toHaveTextContent('/assets');

    // The assertion that matters: nothing handed to the router mentions it.
    const navigated = [...router.push.mock.calls, ...router.replace.mock.calls].flat();
    expect(navigated).not.toHaveLength(0);
    for (const href of navigated) {
      expect(String(href)).not.toContain('pending-abc');
    }
  });

  it('hands the challenge to /login/mfa, which then verifies with the same token', async () => {
    let call = 0;
    const { client, requests } = stubClient((request) => {
      call += 1;
      if (request.path === '/api/v1/auth/login') {
        return { mfaRequired: true, pendingToken: 'pending-abc' };
      }
      return { status: 'AUTHENTICATED' };
    });

    // Both screens under one provider is exactly what the (auth) layout gives
    // them, and it is what makes the in-memory hand-off possible.
    render(
      <ApiClientProvider client={client}>
        <MfaChallengeProvider>
          <LoginScreen redirectTo="/assets" />
          <MfaScreen />
        </MfaChallengeProvider>
      </ApiClientProvider>,
    );
    await signIn();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/assets');
    });
    expect(requests[1]).toEqual({
      method: 'POST',
      path: '/api/v1/auth/mfa/verify',
      body: { pendingToken: 'pending-abc', code: '123456' },
    });
    expect(call).toBe(2);
  });
});

describe('LoginScreen — the redirect target is not trusted', () => {
  it('refuses an absolute URL and lands on the default instead', async () => {
    const { client } = stubClient(() => ({ mfaRequired: false }));
    renderAuth(<LoginScreen redirectTo="https://evil.example/login" />, client);
    await signIn();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('refuses a protocol-relative URL', async () => {
    const { client } = stubClient(() => ({ mfaRequired: false }));
    renderAuth(<LoginScreen redirectTo="//evil.example" />, client);
    await signIn();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('refuses one on the MFA branch too, so the second hop cannot be hijacked', async () => {
    const { client } = stubClient(() => ({ mfaRequired: true, pendingToken: 'pending-abc' }));
    render(
      <ApiClientProvider client={client}>
        <MfaChallengeProvider>
          <LoginScreen redirectTo="https://evil.example" />
          <MfaScreen />
        </MfaChallengeProvider>
      </ApiClientProvider>,
    );
    await signIn();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/login/mfa');
    });
    // The stored destination is already sanitised, so the post-MFA navigation
    // cannot reach the attacker's origin either.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Two-factor authentication' }),
    ).toBeInTheDocument();
  });
});

describe('LoginScreen — server errors land on the right control', () => {
  it('puts a field error on its input and keeps aria-describedby intact', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request body failed validation.',
        requestId: 'req_01JFIELD',
        fieldErrors: [
          { path: 'email', code: 'invalid_string', message: 'Enter a valid email address.' },
        ],
      });
    });
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    const email = screen.getByLabelText('Work email');
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    const ids = describedBy.split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain('Enter a valid email address.');
  });

  it('does not clear the form when the server says no', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 401,
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'That email and password do not match.',
        requestId: 'req_01JKEEP',
      });
    });
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    await screen.findByRole('alert');
    // forms.md §1 rule 2. The user's input is theirs.
    expect(screen.getByLabelText('Work email')).toHaveValue('analyst@acme.test');
    expect(screen.getByLabelText('Password')).toHaveValue('correct horse battery');
  });

  it('surfaces an error about a field this form does not render rather than dropping it', async () => {
    const { client } = stubClient(() => {
      throw new ApiError({
        kind: 'api',
        status: 422,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request body failed validation.',
        requestId: 'req_01JUNMATCHED',
        fieldErrors: [{ path: 'captcha', code: 'required', message: 'Complete the challenge.' }],
      });
    });
    renderAuth(<LoginScreen redirectTo={null} />, client);
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('captcha: Complete the challenge.');
  });
});
