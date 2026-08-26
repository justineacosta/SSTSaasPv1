import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { apiEnvSchema, type ApiEnv, loadEnv } from '@sentinel/config';
import { createLogger } from '@sentinel/observability';
import { EMAIL_TEMPLATES } from '../../modules/auth/emails/registry.js';
import { mintSecretToken } from '../../modules/auth/secret-token.js';
import type { Mailer } from './mailer.port.js';
import { SmtpMailer } from './smtp-mailer.js';

loadDotenv({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

/**
 * A REAL SMTP MESSAGE, READ BACK OUT OF A REAL SERVER.
 *
 * Ruling 52, and the deliverable of this task. No mock transport, no
 * nodemailer `jsonTransport`, no stub: the adapter under test is the adapter,
 * the connection is a TCP connection to the compose Mailpit on 1025, and every
 * assertion below is made against what Mailpit's HTTP API says it received.
 * The plan's words are "a mock here would be mocking the thing under test".
 *
 * There is no Postgres harness here on purpose — this task touches no table, so
 * `startPostgresHarness()` would buy a container and a minute of CI for nothing.
 * The compose stack is reached through the root `.env`, exactly the way
 * `common/guards/rate-limit.integration.spec.ts` reaches Redis.
 *
 * ## This spec must not disturb another suite's mail
 *
 * Ruling 50, which is carry-forward ruling 33 pointed at Mailpit. Mailpit is one
 * container with **one shared mailbox**, and its API offers
 * `DELETE /api/v1/messages`, which deletes everything in it. That call appears
 * nowhere in this file. `rate-limit.integration.spec.ts` deleted a Redis
 * namespace another spec was writing to, its comment claimed the narrowing
 * "protects other suites", and it did not — that cost this project a session,
 * and the failure appeared in a different file from the deletion.
 *
 * Instead every case sends to **its own random address** and finds its message
 * by searching for that address. Nothing here reads a message it did not send,
 * so the spec is correct even when it is one day run in parallel with another
 * that sends mail, and it leaves a developer's own Mailpit inbox intact.
 */

const MAILPIT_HTTP_PORT = 8025;
const DELIVERY_TIMEOUT_MS = 10_000;

let env: ApiEnv;
let mailpitBaseUrl: string;
let mailer: Mailer;

interface MailpitSummary {
  readonly ID: string;
}

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
  readonly From: { readonly Address: string };
  readonly Text: string;
  readonly HTML: string;
}

/** A fresh local part per case, so no two cases can ever see each other's mail. */
function uniqueRecipient(): string {
  return `task05-${randomUUID()}@sentinel.test`;
}

/**
 * Finds this case's message by its unique recipient, polling because SMTP
 * acceptance and the HTTP API's view of the store are two different things.
 * Fails with a message naming the address rather than timing out anonymously.
 */
async function waitForMessage(recipient: string): Promise<MailpitMessage> {
  const query = `${mailpitBaseUrl}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`;
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;

  for (;;) {
    const response = await fetch(query);
    if (!response.ok) throw new Error(`Mailpit search failed: ${String(response.status)}`);
    const found = (await response.json()) as { messages: MailpitSummary[] };
    const first = found.messages[0];

    if (first !== undefined) {
      const detail = await fetch(`${mailpitBaseUrl}/api/v1/message/${first.ID}`);
      if (!detail.ok) throw new Error(`Mailpit message fetch failed: ${String(detail.status)}`);
      return (await detail.json()) as MailpitMessage;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `No message delivered to ${recipient} within ${String(DELIVERY_TIMEOUT_MS)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(() => {
  env = loadEnv(apiEnvSchema);
  // Mailpit's HTTP API sits beside its SMTP port on the same host —
  // infra/docker/docker-compose.yml publishes 1025 and 8025 together, and CI
  // starts the same service (.github/workflows/ci.yml). Derived from MAIL_HOST
  // rather than hardcoded twice, so a stack moved to another address does not
  // leave this spec talking to nothing while claiming to test the configured
  // one.
  mailpitBaseUrl = `http://${env.MAIL_HOST}:${String(MAILPIT_HTTP_PORT)}`;
  mailer = new SmtpMailer(
    {
      host: env.MAIL_HOST,
      port: env.MAIL_PORT,
      from: env.MAIL_FROM,
      secure: env.MAIL_SECURE,
      username: env.MAIL_USERNAME,
      password: env.MAIL_PASSWORD,
    },
    createLogger({ service: 'test', level: 'warn', pretty: false, silent: true }),
    // No third argument: this is the real nodemailer transport. That is the
    // whole point of the file.
  );
});

describe('the SMTP adapter against the compose Mailpit', () => {
  it('delivers a verification email whose link carries the token as ?token=', async () => {
    const recipient = uniqueRecipient();
    const { token } = mintSecretToken();
    const rendered = EMAIL_TEMPLATES.emailVerification({
      recipientName: 'Ada Lovelace',
      webBaseUrl: env.WEB_BASE_URL,
      token,
      ttlSeconds: env.TOKEN_TTL_EMAIL_VERIFICATION_SECONDS,
    });

    const sent = await mailer.send({
      templateId: 'emailVerification',
      to: recipient,
      ...rendered,
    });
    expect(sent.messageId.length).toBeGreaterThan(0);

    const message = await waitForMessage(recipient);
    expect(message.To.map((address) => address.Address)).toContain(recipient);
    expect(message.Subject).toBe('Confirm your email address');

    // Ruling 52: parsed as a URL, not matched as a substring, so the assertion
    // is about a real link rather than about some text that happens to contain
    // the token.
    const found = message.Text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    const link = new URL(found[0] ?? '');
    expect(link.searchParams.get('token')).toBe(token);
    expect(link.pathname).toBe('/verify-email');
    expect(link.origin).toBe(new URL(env.WEB_BASE_URL).origin);
  });

  it('delivers both a text part and an html part, as Mailpit reports them', async () => {
    // The rule ruling 45 enforces over the registry, checked here at the layer
    // that could still drop one: a template can render both parts perfectly and
    // the adapter can still fail to attach one.
    const recipient = uniqueRecipient();
    const { token } = mintSecretToken();
    const rendered = EMAIL_TEMPLATES.passwordReset({
      recipientName: 'Ada Lovelace',
      webBaseUrl: env.WEB_BASE_URL,
      token,
      ttlSeconds: env.TOKEN_TTL_PASSWORD_RESET_SECONDS,
    });

    await mailer.send({ templateId: 'passwordReset', to: recipient, ...rendered });

    const message = await waitForMessage(recipient);
    expect(message.Text.trim().length).toBeGreaterThan(0);
    expect(message.HTML.trim().length).toBeGreaterThan(0);
    expect(message.HTML).toContain('<!doctype html>');
    expect(message.Text).not.toContain('<');
    // Both parts carry the same live link — a text-only client must not be left
    // with a message it cannot act on.
    expect(message.Text).toContain(`token=${token}`);
    expect(message.HTML).toContain(`token=${token}`);
  });

  it('sends from the configured MAIL_FROM address', async () => {
    const recipient = uniqueRecipient();
    await mailer.send({
      templateId: 'newDeviceSignIn',
      to: recipient,
      ...EMAIL_TEMPLATES.newDeviceSignIn({
        recipientName: 'Ada Lovelace',
        occurredAt: new Date('2026-08-26T09:41:07.512Z'),
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      }),
    });

    const message = await waitForMessage(recipient);
    // MAIL_FROM is `Display Name <address>`; Mailpit splits it, so compare the
    // address it parsed against the address inside the configured value.
    expect(env.MAIL_FROM).toContain(message.From.Address);
  });

  it('delivers a notice email that contains no link at all', async () => {
    // Asserted against what actually arrived rather than against the render, so
    // nothing the transport adds — a tracking wrapper, a rewritten URL, an
    // unsubscribe footer injected by a relay — can put a link into a security
    // notice without failing here.
    const recipient = uniqueRecipient();
    await mailer.send({
      templateId: 'mfaDisabled',
      to: recipient,
      ...EMAIL_TEMPLATES.mfaDisabled({
        recipientName: 'Ada Lovelace',
        occurredAt: new Date('2026-08-26T09:41:07.512Z'),
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      }),
    });

    const message = await waitForMessage(recipient);
    expect(message.Subject).toContain('disabled');
    expect(message.Text).not.toMatch(/https?:\/\//);
    expect(message.HTML).not.toMatch(/https?:\/\//);
  });

  it('escapes an attacker-chosen display name in the delivered html part', async () => {
    // The end of the chain ruling 44 protects. Escaping is asserted at the
    // template layer too; this proves nothing between the template and the
    // recipient's mailbox — MIME encoding, quoted-printable, the transport —
    // undoes it.
    const recipient = uniqueRecipient();
    const { token } = mintSecretToken();
    await mailer.send({
      templateId: 'emailVerification',
      to: recipient,
      ...EMAIL_TEMPLATES.emailVerification({
        recipientName: '<script>alert(1)</script>',
        webBaseUrl: env.WEB_BASE_URL,
        token,
        ttlSeconds: env.TOKEN_TTL_EMAIL_VERIFICATION_SECONDS,
      }),
    });

    const message = await waitForMessage(recipient);
    expect(message.HTML).not.toContain('<script>');
    expect(message.HTML).toContain('&lt;script&gt;');
  });

  it('raises rather than hanging when the relay is unreachable', async () => {
    // ADR-0016: a failed send raises and is logged, it is not retried and not
    // queued. Port 1 is unbound, so this is a refused connection rather than a
    // timeout, and it exercises the real nodemailer error path.
    const dead = new SmtpMailer(
      { host: '127.0.0.1', port: 1, from: env.MAIL_FROM, secure: false },
      createLogger({ service: 'test', level: 'warn', pretty: false, silent: true }),
    );

    await expect(
      dead.send({
        templateId: 'passwordChanged',
        to: uniqueRecipient(),
        subject: 'x',
        html: '<p>x</p>',
        text: 'x',
      }),
    ).rejects.toThrow();
  });
});
