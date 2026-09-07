import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@sentinel/contracts';
import { ApiError } from '../api/errors';
import { renderApp, stubClient, type RecordedRequest } from '../app/render-helpers';
import { MfaPanel } from './MfaPanel';
import { RECOVERY_CODES_WARNING } from './RecoveryCodes';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'JBSWY3DPEHPK3PXP';
const OTPAUTH = `otpauth://totp/Sentinel:analyst@acme.test?secret=${SECRET}&issuer=Sentinel`;
const CODES = [
  'abcd-efghi',
  'jklm-nopqr',
  'stuv-wxyza',
  'bcde-fghij',
  'klmn-opqrs',
  'tuvw-xyzab',
  'cdef-ghijk',
  'lmno-pqrst',
  'uvwx-yzabc',
  'defg-hijkl',
];

function respond(request: RecordedRequest): unknown {
  if (request.path === '/api/v1/auth/mfa/enroll') return { secret: SECRET, otpauthUri: OTPAUTH };
  if (request.path === '/api/v1/auth/mfa/confirm') return { recoveryCodes: CODES };
  if (request.path === '/api/v1/auth/mfa/recovery-codes') return { recoveryCodes: CODES };
  if (request.path === '/api/v1/auth/mfa/disable') return { status: 'MFA_DISABLED' };
  throw new Error(`unexpected request: ${request.method} ${request.path}`);
}

async function enrol(): Promise<void> {
  const forms = screen.getAllByLabelText('Current password');
  await userEvent.type(forms[0] as HTMLElement, PASSWORD);
  await userEvent.click(screen.getByRole('button', { name: 'Begin enrolment' }));
}

describe('MfaPanel — enrolment', () => {
  it('posts the password, then shows the QR code and the manual key', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    await enrol();

    await waitFor(() => {
      expect(requests[0]).toMatchObject({
        method: 'POST',
        path: '/api/v1/auth/mfa/enroll',
        body: { password: PASSWORD },
      });
    });

    // The QR code is drawn as an SVG the component built from the modules, so
    // it is queryable by its accessible name rather than by a data URL.
    expect(
      await screen.findByRole('img', { name: 'Authenticator enrolment QR code' }),
    ).toBeInTheDocument();
    // The manual key is offered beside it: an authenticator that cannot scan is
    // entered by hand, and the secret is shown once either way.
    expect(screen.getByTestId('mfa-secret')).toHaveTextContent(SECRET);
  });

  it('confirms with the typed code and then shows the recovery codes ONCE, with the warning', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    await enrol();
    await screen.findByTestId('mfa-secret');

    await userEvent.type(screen.getByLabelText('Code from your authenticator'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByTestId('recovery-codes')).toBeInTheDocument();
    // The requirement `api/authentication.md` §4 states, asserted on the path
    // that actually produces the codes rather than only on the component.
    expect(screen.getByText(RECOVERY_CODES_WARNING)).toBeInTheDocument();
    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument();

    expect(requests[1]).toMatchObject({
      method: 'POST',
      path: '/api/v1/auth/mfa/confirm',
      body: { code: '123456' },
    });
  });

  it('does not send the enrolment password again on confirmation', async () => {
    // `api/authentication.md` §2: confirm is the one of the four that does not
    // require the password, because it is reachable only inside the window the
    // enrolment opened. Sending it anyway would be a strict request schema away
    // from a 400.
    const { client, requests } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    await enrol();
    await screen.findByTestId('mfa-secret');
    await userEvent.type(screen.getByLabelText('Code from your authenticator'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]?.body).toEqual({ code: '123456' });
  });

  it('renders a server refusal instead of proceeding', async () => {
    const { client } = stubClient(() => {
      // A real `ApiError`, not a bare `Error`: `serverFormErrors` deliberately
      // replaces an unrecognised rejection with a generic sentence rather than
      // rendering whatever a stray throw carried, so a bare `Error` here would
      // be testing the fallback instead of the refusal.
      throw new ApiError({
        kind: 'api',
        status: 409,
        code: ERROR_CODES.DUPLICATE_RESOURCE,
        message: 'An authenticator is already enrolled on this account.',
        requestId: 'req_mfa_409',
      });
    });
    renderApp(<MfaPanel />, client);

    await enrol();

    expect(await screen.findByText(/already enrolled/)).toBeInTheDocument();
    expect(screen.queryByTestId('mfa-secret')).not.toBeInTheDocument();
  });
});

describe('MfaPanel — reissuing and disabling', () => {
  it('reissues the whole set and shows it once', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    const passwords = screen.getAllByLabelText('Current password');
    await userEvent.type(passwords[1] as HTMLElement, PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Reissue codes' }));

    expect(await screen.findByTestId('recovery-codes')).toBeInTheDocument();
    expect(screen.getByText(RECOVERY_CODES_WARNING)).toBeInTheDocument();
    expect(requests[0]?.path).toBe('/api/v1/auth/mfa/recovery-codes');
  });

  it('asks a second time before disabling, and only then sends the request', async () => {
    const { client, requests } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    const passwords = screen.getAllByLabelText('Current password');
    await userEvent.type(passwords[2] as HTMLElement, PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Turn it off' }));

    expect(requests).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Yes, turn it off' }));

    await waitFor(() => {
      expect(requests[0]).toMatchObject({
        method: 'POST',
        path: '/api/v1/auth/mfa/disable',
        body: { password: PASSWORD },
      });
    });
    expect(await screen.findByText('Two-factor authentication is off.')).toBeInTheDocument();
  });

  it('warns what disabling costs before it happens', async () => {
    const { client } = stubClient(respond);
    renderApp(<MfaPanel />, client);

    expect(
      screen.getByText(/deletes your authenticator and every recovery code/),
    ).toBeInTheDocument();
  });
});
