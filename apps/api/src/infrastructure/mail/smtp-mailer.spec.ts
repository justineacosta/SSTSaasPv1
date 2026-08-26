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

  /**
   * ONE RECIPIENT — NOT MERELY ONE LINE.
   *
   * H1 (Task 5 review). The guard this table replaces refused CR, LF and NUL
   * and nothing else. Measured against `to: 'a@b.test, attacker@evil.test'` it
   * produced **two** `RCPT TO` commands on the wire, and the same shape against
   * the real compose Mailpit delivered the message to the attacker address:
   * nodemailer parses `to` as an address *list*, so refusing line breaks does
   * not make a string one address. The token-link templates carry a live
   * single-use credential, which makes the extra recipient a password reset.
   *
   * Envelope-level header injection — `to` reaches an RCPT command and a `To:`
   * header — is the original case and stays in the table rather than in its own
   * test. A table because the defect was a rule that held only for the shapes
   * someone had thought of; the cheapest defence against that is to make adding
   * a shape one line.
   */
  const HOSTILE_RECIPIENTS: readonly (readonly [string, string])[] = [
    ['a comma-separated list', 'ada@example.test, attacker@evil.test'],
    ['a comma with no space', 'ada@example.test,attacker@evil.test'],
    ['a semicolon-separated list', 'ada@example.test;attacker@evil.test'],
    ['a display name in angle brackets', 'Ada <ada@example.test>'],
    ['RFC 5322 group syntax', 'undisclosed:;'],
    ['CRLF header injection', 'ada@example.test\r\nBcc: attacker@evil.test'],
    ['a bare LF', 'ada@example.test\nBcc: attacker@evil.test'],
    ['a NUL', 'ada@example.test\u0000'],
    ['a leading space', ' ada@example.test'],
    ['a trailing tab', 'ada@example.test\t'],
    ['an internal space', 'ada @example.test'],
    ['two at signs', 'ada@example.test@evil.test'],
    ['no at sign at all', 'ada'],
    ['an empty address', ''],
  ];

  it.each(HOSTILE_RECIPIENTS)('refuses a recipient carrying %s', async (_shape, to) => {
    const transport = recordingTransport();
    await expect(build(transport).send({ ...MAIL, to })).rejects.toThrow(/exactly one/);
    // Refused, not repaired: nothing reached the transport.
    expect(transport.sent).toHaveLength(0);
  });

  it('does not repeat the rejected address in the error it raises', async () => {
    // The address is caller-supplied and this error is logged. Naming it would
    // put the injected fragment — `Bcc: attacker@evil.test` — into a log line,
    // which is the same defect class as the injection it refused.
    let message = '';
    try {
      await build(recordingTransport()).send({
        ...MAIL,
        to: 'ada@example.test, attacker@evil.test',
      });
      expect.unreachable('a two-address recipient must be refused');
    } catch (error) {
      message = (error as Error).message;
    }
    // Must actually have thrown, or the assertion below is vacuous.
    expect(message).toContain('exactly one');
    expect(message).not.toContain('attacker@evil.test');
  });

  it('still accepts an ordinary single address', async () => {
    // The table above is worthless if the rule also refuses real mail. A `+`
    // tag is the everyday address shape most likely to be caught by a guard
    // written too tightly.
    const transport = recordingTransport();
    await build(transport).send({ ...MAIL, to: 'ada.lovelace+sentinel@example.test' });
    expect(transport.sent).toHaveLength(1);
  });

  it('sanitises the subject at the port, not only inside renderEmail', async () => {
    // M2 (Task 5 review). `sanitizeSubject` ran only inside `renderEmail`, and
    // `OutgoingMail` is a plain interface: a caller that assembles one directly
    // — which the port's type permits and its docblock invites — reached the
    // transport with an unsanitised header value. Measured against the real
    // Mailpit, nothing was injected, but only because nodemailer's MIME encoder
    // folded the CRLF, and a control that exists only inside a dependency is a
    // control that changes when the dependency does. This is the same argument
    // the adapter already makes for duplicating the credential-pair check into
    // `toTransportOptions`, applied to the other header it controls.
    const transport = recordingTransport();
    await build(transport).send({ ...MAIL, subject: 'Hello\r\nBcc: attacker@evil.test' });
    expect(transport.sent[0]?.subject).toBe('Hello Bcc: attacker@evil.test');
  });

  it('collapses any control character in the subject, not only CR and LF', async () => {
    const transport = recordingTransport();
    await build(transport).send({ ...MAIL, subject: 'Reset\u0007your\u001bpassword' });
    expect(transport.sent[0]?.subject).toBe('Reset your password');
  });

  it('leaves an ordinary subject exactly as the template rendered it', async () => {
    // `renderEmail` has already sanitised every subject that comes from a
    // template. Running the same function twice must be a no-op, or the port
    // would quietly differ from what the html and text parts say the message
    // is called.
    const transport = recordingTransport();
    await build(transport).send(MAIL);
    expect(transport.sent[0]?.subject).toBe(MAIL.subject);
  });

  it('builds its transport once, not once per message', async () => {
    // What this pins is the factory call count, and that is all it claims. The
    // transport is built once because constructing it opens no connection,
    // which is what ruling 49's boot-with-the-relay-down depends on.
    //
    // It is **not** about pooling: `pool` is not set anywhere, nodemailer
    // selects its pooling transport only under `if (options.pool)`, and each
    // send was measured opening and closing its own TCP connection. The
    // sentence that used to be here said otherwise and was false (M3, Task 5
    // review); pooling is not configured and this phase does not configure it.
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
