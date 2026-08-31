import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from '@sentinel/config';
import { createLogger } from '@sentinel/observability';
import type { Mailer } from '../../infrastructure/mail/mailer.port.js';
import { AuthMailer } from './auth-mailer.js';
import { type SecretTokenTtlSeconds, TokenService } from './token.service.js';

/**
 * THE ABSORBED-FAILURE LOG LINE CARRIES NO BODY — ASSERTED, NOT ASSUMED.
 *
 * L3, Task 8 review. `deliver` swallows a send failure and logs it, and its
 * comment says "the recipient is logged and the body is not". The reviewer added
 * `body: rendered.html, text: rendered.text` to those bindings and 1085 unit and
 * 39 integration tests stayed green, so the sentence was the only thing holding
 * it. For `emailVerification` that body contains the live `?token=` link.
 *
 * **What the redactor does and does not do here, measured — an earlier version
 * of this docblock got it wrong (F2).** It is a VALUE-shape net, not a
 * field-name denylist for these keys: `SECRET_KEY_FRAGMENTS` in
 * `packages/observability/src/redaction.ts` lists `password`, `token`,
 * `cookie` and the rest, and neither `body` nor `text` is on it.
 * `redact({ body: '<a notice body>' })` returns it **verbatim**;
 * `redact({ body: '…?token=…' })` returns `[redacted]` because the value
 * matched. So a verification body is saved by its own link and the five
 * link-free notices are not saved at all.
 *
 * That is why this file asserts an EXACT KEY SET rather than searching the line
 * for content. A value-based assertion cannot fail for a token-bearing template
 * (the redactor rescues it) and would not have to fail for a notice (nothing
 * rescues it) — only the key set holds the actual claim, which is that
 * `deliver` passes no body in the first place.
 *
 * The same shape as `infrastructure/mail/mail.redaction.spec.ts`, one layer up.
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

const TTL: SecretTokenTtlSeconds = {
  EMAIL_VERIFICATION: 86_400,
  PASSWORD_RESET: 3_600,
  INVITATION: 604_800,
};

const ENV = { WEB_BASE_URL: 'https://app.sentinel.test' } as ApiEnv;

/** A mailer that always refuses, which is the only path that logs. */
const refusingMailer: Mailer = {
  send: () => Promise.reject(new Error('550 mailbox unavailable')),
};

describe('AuthMailer, when a send fails', () => {
  it('logs the template and recipient and absorbs the failure', async () => {
    const { logger, lines } = captureLogger();
    const mailer = new AuthMailer(refusingMailer, ENV, new TokenService({} as never, TTL), logger);

    await expect(
      mailer.sendVerification({
        to: 'ada@example.test',
        token: 'FIXTURE_token_that_must_not_be_logged_00',
      }),
    ).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('emailVerification');
    expect(lines[0]).toContain('ada@example.test');
  });

  it('puts neither the rendered body nor the raw token in the line', async () => {
    const { logger, lines } = captureLogger();
    const mailer = new AuthMailer(refusingMailer, ENV, new TokenService({} as never, TTL), logger);
    const token = 'FIXTURE_token_that_must_not_be_logged_00';

    await mailer.sendVerification({ to: 'ada@example.test', token });

    const line = lines.join('');
    expect(line).not.toContain(token);
    expect(line).not.toContain(encodeURIComponent(token));
    expect(line).not.toContain('Confirm this address');
    expect(line).not.toContain('app.sentinel.test/verify-email');
  });

  it('logs an EXACT set of fields, so adding the body is a failure and not a redaction', async () => {
    // The assertion the reviewer's mutation needed, and writing it taught me
    // something the finding had not: adding `body` and `text` to these bindings
    // does NOT put the body in the log. The redacting serialiser blanks those
    // two field NAMES outright — the emitted line reads `"body":"[redacted]"` —
    // so a value-based assertion cannot fail, and my first attempt at this test
    // could not either.
    //
    // That makes the field-name denylist a real second line of defence rather
    // than the incidental one L3 assumed. It is still not the first: the first
    // is that `deliver` does not pass the body at all, and a field name outside
    // the denylist would carry it straight through. An exact key set is the only
    // assertion that holds THAT claim, because a new binding changes the keys
    // whether or not its value survives redaction.
    const { logger, lines } = captureLogger();
    const mailer = new AuthMailer(refusingMailer, ENV, new TokenService({} as never, TTL), logger);

    await mailer.sendVerification({
      to: 'ada@example.test',
      token: 'FIXTURE_x',
    });

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(
      ['err', 'level', 'msg', 'recipient', 'service', 'templateId', 'time'].sort(),
    );
  });
});
