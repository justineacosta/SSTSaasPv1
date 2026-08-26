import { describe, expect, it, vi } from 'vitest';
import type { OutgoingMail } from './mailer.port.js';
import {
  type CreateSmtpTransport,
  type SmtpMailerConfig,
  SmtpMailer,
  type SmtpTransport,
  toTransportOptions,
} from './smtp-mailer.js';

const CONFIG: SmtpMailerConfig = {
  host: '127.0.0.1',
  port: 1025,
  from: 'Sentinel <no-reply@sentinel.local>',
  secure: false,
};

const MAIL: OutgoingMail = {
  templateId: 'emailVerification',
  to: 'ada@example.test',
  subject: 'Confirm your email address',
  html: '<p>hello</p>',
  text: 'hello',
};

interface RecordingTransport extends SmtpTransport {
  readonly sent: Parameters<SmtpTransport['sendMail']>[0][];
  readonly verifyCalls: number;
}

function recordingTransport(messageId = '<abc@sentinel.local>'): RecordingTransport {
  const sent: Parameters<SmtpTransport['sendMail']>[0][] = [];
  let verifyCalls = 0;
  return {
    sent,
    get verifyCalls() {
      return verifyCalls;
    },
    verify: () => {
      verifyCalls += 1;
      return Promise.resolve(true);
    },
    sendMail: (message) => {
      sent.push(message);
      return Promise.resolve({ messageId });
    },
  };
}

const silentLogger = { info: vi.fn(), error: vi.fn() };

describe('toTransportOptions', () => {
  it('carries host, port and the implicit-TLS flag through unchanged', () => {
    expect(toTransportOptions(CONFIG)).toMatchObject({
      host: '127.0.0.1',
      port: 1025,
      secure: false,
    });
  });

  it('omits auth entirely when no credentials are configured', () => {
    // Mailpit accepts unauthenticated mail and every environment that exists
    // today is unauthenticated. An `auth` object with undefined members is not
    // the same as no `auth` — nodemailer would attempt AUTH and fail.
    expect(toTransportOptions(CONFIG).auth).toBeUndefined();
  });

  it('passes auth only when both a username and a password are present', () => {
    const options = toTransportOptions({
      ...CONFIG,
      username: 'relay-user',
      password: 'relay-secret',
    });
    expect(options.auth).toEqual({ user: 'relay-user', pass: 'relay-secret' });
  });

  it('refuses a username with no password', () => {
    // Ruling 48. `apiEnvSchema` refuses this at boot as well, deliberately: the
    // adapter is constructible from something other than the environment, and a
    // control that lives only in the schema is a control the next caller
    // bypasses. nodemailer given half a credential drops `auth` and sends
    // unauthenticated rather than failing, so the misconfiguration would
    // otherwise surface as mail that silently does not arrive.
    expect(() => toTransportOptions({ ...CONFIG, username: 'relay-user' })).toThrow(
      /MAIL_PASSWORD/,
    );
  });

  it('refuses a password with no username', () => {
    expect(() => toTransportOptions({ ...CONFIG, password: 'relay-secret' })).toThrow(
      /MAIL_USERNAME/,
    );
  });

  it('does not put the password in the message of the error it raises', () => {
    const password = 'S3CR3T-RELAY-PASSWORD';
    let message = '';
    try {
      toTransportOptions({ ...CONFIG, password });
      expect.unreachable('half a credential must be refused');
    } catch (error) {
      message = (error as Error).message;
    }
    // Must actually have thrown, or the assertion below is vacuous — the same
    // trap `env.spec.ts` records for its own no-leak property test.
    expect(message).toContain('MAIL_USERNAME');
    expect(message).not.toContain(password);
  });
});

describe('SmtpMailer', () => {
  function build(transport: SmtpTransport, config: SmtpMailerConfig = CONFIG): SmtpMailer {
    const create: CreateSmtpTransport = () => transport;
    return new SmtpMailer(config, silentLogger, create);
  }

  it('sends both parts and the configured From address', () => {
    const transport = recordingTransport();
    return (async () => {
      await build(transport).send(MAIL);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toEqual({
        from: 'Sentinel <no-reply@sentinel.local>',
        to: 'ada@example.test',
        subject: 'Confirm your email address',
        text: 'hello',
        html: '<p>hello</p>',
      });
    })();
  });

  it('returns the message id the server assigned', async () => {
    const transport = recordingTransport('<server-chosen@relay.test>');
    await expect(build(transport).send(MAIL)).resolves.toEqual({
      messageId: '<server-chosen@relay.test>',
    });
  });

  it('never opens a connection at construction time', async () => {
    // Ruling 49. The API must boot with the mail server down: mail is not on
    // the liveness path, and an unreachable relay must not stop the service
    // that serves everything else. `transporter.verify()` in a constructor or
    // an onModuleInit turns an SMTP outage into an API outage, when the health
    // endpoints already exist to report degradation without refusing to start.
    const transport = recordingTransport();
    const mailer = build(transport);
    expect(transport.verifyCalls).toBe(0);
    await mailer.send(MAIL);
    expect(transport.verifyCalls).toBe(0);
  });

  it('raises when the transport fails, rather than swallowing it', async () => {
    // ADR-0016 is explicit that a failed send in Phase 2 raises and is logged;
    // it is not retried and not queued. Swallowing it would make that gap
    // invisible instead of merely unhandled.
    const failing: SmtpTransport = {
      verify: () => Promise.resolve(true),
      sendMail: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
    };
    await expect(build(failing).send(MAIL)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses a recipient containing CRLF', async () => {
    // Envelope-level header injection: `to` reaches an RCPT command and a To:
    // header. Task 8 will pass an address that came from a registration form,
    // and the address is validated by Zod at that boundary — this is the second
    // line, on the same reasoning as the subject sanitiser in the layout.
    const transport = recordingTransport();
    await expect(
      build(transport).send({ ...MAIL, to: 'ada@example.test\r\nBcc: attacker@evil.test' }),
    ).rejects.toThrow();
    expect(transport.sent).toHaveLength(0);
  });

  it('builds its transport once, not once per message', async () => {
    // A transport per send would open a new TCP connection per email and defeat
    // whatever pooling a relay offers. Not a correctness property today — there
    // is one sender and no volume — but a cheap one to pin before there is.
    let created = 0;
    const transport = recordingTransport();
    const create: CreateSmtpTransport = () => {
      created += 1;
      return transport;
    };
    const mailer = new SmtpMailer(CONFIG, silentLogger, create);
    await mailer.send(MAIL);
    await mailer.send(MAIL);
    expect(created).toBe(1);
  });
});
