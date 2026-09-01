import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sentinel/observability';
import { EMAIL_TEMPLATES } from '../../modules/auth/emails/registry.js';
import { mintSecretToken } from '../../modules/auth/secret-token.js';
import { type CreateSmtpTransport, SmtpMailer, type SmtpTransport } from './smtp-mailer.js';

/**
 * THE RENDERED BODY MUST NOT REACH A LOG LINE — MEASURED, NOT ASSUMED.
 *
 * Ruling 47, and deliberately the same shape as
 * `modules/auth/token.redaction.spec.ts`, which Task 4 wrote after measuring
 * that a real 256-bit token survived three of four log shapes.
 *
 * Three of the eight templates put a live single-use credential in their body,
 * and the adapter is the one place that holds all three parts of a message at
 * once. The redaction pattern in `@sentinel/observability` is the **second**
 * line of defence here, not the first: the first is that the adapter logs the
 * template id, the recipient and the server's message id, and nothing else. A
 * spec that only asserted "the token does not appear" would stay green if the
 * adapter started logging the whole body and redaction happened to catch it —
 * so the last two cases assert the body is absent as well.
 *
 * The token used below is minted by the real primitive rather than typed as a
 * literal, for the same reason Task 4 gave: a hand-written value can be shorter
 * or lower-entropy than a real one and pass a length- or shape-sensitive
 * pattern that a real token would not.
 */
function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return {
    logger: createLogger({ service: 'api', level: 'debug', pretty: false, stream }),
    lines,
  };
}

const transport: SmtpTransport = {
  verify: () => Promise.resolve(true),
  sendMail: () => Promise.resolve({ messageId: '<generated@sentinel.local>' }),
};
const create: CreateSmtpTransport = () => transport;

const failingTransport: SmtpTransport = {
  verify: () => Promise.resolve(true),
  sendMail: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:1025')),
};

const CONFIG = {
  host: '127.0.0.1',
  port: 1025,
  from: 'Sentinel <no-reply@sentinel.local>',
  secure: false,
} as const;

describe('a real verification email through the SMTP adapter', () => {
  it('leaves no trace of the token in the captured log output', async () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    const rendered = EMAIL_TEMPLATES.emailVerification({
      webBaseUrl: 'https://app.sentinel.test',
      token,
      ttlSeconds: 86_400,
    });

    await new SmtpMailer(CONFIG, logger, create).send({
      templateId: 'emailVerification',
      to: 'ada@example.test',
      ...rendered,
    });

    expect(lines.join('')).not.toContain(token);
  });

  it('leaves no trace of the token when the send fails and is logged', async () => {
    // The error path is the one that gets written last and reviewed least, and
    // a failed send is exactly when someone reaches for "log the message so we
    // can see what broke".
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    // No `recipientName`: `PasswordResetInput` has none as of Task 10 (ruling
    // 70, closed), so passing one is a compile error rather than a choice.
    const rendered = EMAIL_TEMPLATES.passwordReset({
      webBaseUrl: 'https://app.sentinel.test',
      token,
      ttlSeconds: 3_600,
    });

    await expect(
      new SmtpMailer(CONFIG, logger, () => failingTransport).send({
        templateId: 'passwordReset',
        to: 'ada@example.test',
        ...rendered,
      }),
    ).rejects.toThrow();

    expect(lines.join('')).not.toContain(token);
  });

  it('logs no part of the rendered body at all, redacted or otherwise', async () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    const rendered = EMAIL_TEMPLATES.emailVerification({
      webBaseUrl: 'https://app.sentinel.test',
      token,
      ttlSeconds: 86_400,
    });

    await new SmtpMailer(CONFIG, logger, create).send({
      templateId: 'emailVerification',
      to: 'ada@example.test',
      ...rendered,
    });

    const output = lines.join('');
    // A distinctive sentence from each part. Neither is secret; the point is
    // that no body content is in the log, so redaction is never the only thing
    // standing between a credential and a log file.
    expect(output).not.toContain('Confirm this address to finish setting up');
    expect(output).not.toContain('word-break:break-all');
    expect(output).not.toContain('verify-email');
  });

  it('does log the template id, the recipient and the server message id', async () => {
    // The positive control. Without it, an adapter that logged nothing at all
    // would satisfy every assertion above while leaving an operator unable to
    // tell whether a notice email was ever sent — and ADR-0016 names silent
    // non-delivery of a security notice as the real gap in this phase.
    const { logger, lines } = captureLogger();
    await new SmtpMailer(CONFIG, logger, create).send({
      templateId: 'mfaDisabled',
      to: 'ada@example.test',
      subject: 'Two-factor authentication was disabled on your Sentinel account',
      html: '<p>x</p>',
      text: 'x',
    });

    const output = lines.join('');
    expect(output).toContain('mfaDisabled');
    expect(output).toContain('ada@example.test');
    expect(output).toContain('<generated@sentinel.local>');
  });
});
