import { createTransport } from 'nodemailer';
import type { Mailer, OutgoingMail, SentMail } from './mailer.port.js';

/**
 * The one adapter behind the `Mailer` port, and the only file in this codebase
 * that knows mail is SMTP.
 *
 * Locally and in CI it points at Mailpit (`infra/docker/docker-compose.yml`,
 * SMTP 1025 / HTTP 8025), which means every email this product sends during
 * Phase 2 is a real SMTP message a human can open and a test can read back.
 * In staging and production the same class points at whatever relay that
 * environment provides — including Resend's own SMTP endpoint. ADR-0016.
 *
 * **It never logs a rendered body and never logs a link.** Ruling 47: three of
 * the six templates put a live single-use credential in their body, and the
 * redaction pattern in `@sentinel/observability` is the second line of defence
 * here rather than the first. What gets logged is the template id, the
 * recipient and the message id the server returned.
 *
 * **It never verifies its connection.** Ruling 49: there is no
 * `transporter.verify()` in the constructor and no `onModuleInit`, because the
 * API must boot with the mail server down. Mail is not on the liveness path,
 * and an unreachable relay must not stop the service that serves everything
 * else — the health endpoints already exist to report degradation without
 * refusing to start.
 */

export interface SmtpMailerConfig {
  readonly host: string;
  readonly port: number;
  /** The `From` header on every message. `MAIL_FROM`. */
  readonly from: string;
  /** Implicit TLS from the first byte (port 465). STARTTLS on 587 is negotiated regardless. */
  readonly secure: boolean;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
}

/** The slice of a transport this adapter uses. A spec supplies its own. */
export interface SmtpTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId?: string | undefined }>;
  /**
   * Present on the interface only so a spec can assert it is **never called** —
   * see ruling 49 and `smtp-mailer.spec.ts`. Nothing in production calls it.
   */
  verify(): Promise<boolean>;
}

export type CreateSmtpTransport = (config: SmtpMailerConfig) => SmtpTransport;

/** The slice of the logger this adapter uses, so a spec is not a mock of pino. */
export interface MailLogger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

interface TransportOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: { readonly user: string; readonly pass: string } | undefined;
}

/**
 * Maps configuration onto nodemailer's options, and refuses half a credential.
 *
 * Ruling 48. `apiEnvSchema` refuses the same configuration at boot, and this is
 * deliberately not a duplicate of that check: the adapter is constructible from
 * something other than the environment — a future factory, a worker, a spec —
 * and a control that lives only in the schema is a control the next caller
 * bypasses. nodemailer given a username with no password does not fail; it
 * drops `auth` and connects unauthenticated, so the misconfiguration surfaces
 * as mail that silently does not arrive.
 *
 * The message names the environment variables rather than the config fields
 * because that is what an operator can act on, and it carries neither value.
 */
export function toTransportOptions(config: SmtpMailerConfig): TransportOptions {
  const base = { host: config.host, port: config.port, secure: config.secure };

  if (config.username === undefined && config.password === undefined) return base;
  if (config.username === undefined) {
    throw new Error('MAIL_PASSWORD is set without MAIL_USERNAME. Set both or neither.');
  }
  if (config.password === undefined) {
    throw new Error('MAIL_USERNAME is set without MAIL_PASSWORD. Set both or neither.');
  }

  return { ...base, auth: { user: config.username, pass: config.password } };
}

/** The one place the real SMTP client is named. Every spec supplies its own. */
export const createNodemailerTransport: CreateSmtpTransport = (config) =>
  createTransport(toTransportOptions(config));

/**
 * `to` reaches an SMTP `RCPT TO` command and a `To:` header, and a header is
 * terminated by CRLF — so an address carrying one is header injection, and
 * `Bcc:` is the header an attacker wants. Task 8 will pass an address that came
 * from a registration form; Zod validates it at that boundary and this is the
 * second line, on the same reasoning as the subject sanitiser in the email
 * layout. Refusing is right rather than stripping: unlike a subject, a mangled
 * address has no useful meaning, and there is no legitimate sender to serve.
 */
// eslint-disable-next-line no-control-regex -- matching the NUL is precisely the point.
const FORBIDDEN_IN_ADDRESS = /[\r\n\u0000]/;

export class SmtpMailer implements Mailer {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly config: SmtpMailerConfig,
    private readonly logger: MailLogger,
    createSmtpTransport: CreateSmtpTransport = createNodemailerTransport,
  ) {
    // Built once, here. A transport per message would open a TCP connection per
    // email and discard whatever pooling the relay offers. Constructing it
    // opens nothing — nodemailer connects lazily on the first `sendMail`, which
    // is what lets the API boot with the relay down (ruling 49).
    this.transport = createSmtpTransport(config);
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    if (FORBIDDEN_IN_ADDRESS.test(mail.to)) {
      throw new Error('Refusing to send: the recipient address contains a line break.');
    }

    // Bound before the try, so the catch below cannot reach `mail.html`,
    // `mail.text` or the link inside them even by accident. Ruling 47.
    const context = { templateId: mail.templateId, recipient: mail.to };

    try {
      const result = await this.transport.sendMail({
        from: this.config.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      const messageId = result.messageId ?? '';
      this.logger.info({ ...context, messageId }, 'email sent');
      return { messageId };
    } catch (error) {
      // The error goes through the logger's redacting `err` serialiser, which
      // matters: an SMTP client puts the connection target, and sometimes the
      // credential, into its own error text. ADR-0016 is explicit that a failed
      // send in Phase 2 raises and is logged — not retried, not queued — so it
      // is rethrown rather than swallowed. Swallowing it would make that gap
      // invisible instead of merely unhandled.
      this.logger.error({ ...context, err: error }, 'email send failed');
      throw error;
    }
  }
}
