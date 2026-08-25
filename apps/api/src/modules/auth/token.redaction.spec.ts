import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sentinel/observability';
import { mintSecretToken } from './secret-token.js';

/**
 * THE TOKEN MUST NOT SURVIVE A LOG LINE — MEASURED, NOT ASSUMED.
 *
 * Critical security rule 6, and §6's whole premise: a raw token in a log is a
 * password reset for anyone with log access.
 *
 * The obvious version of this spec — `logger.info({ token })` — proves nothing.
 * `SECRET_KEY_FRAGMENTS` in `packages/observability/src/redaction.ts` already
 * contains `token`, so that object is redacted **by key name** whatever the
 * value looks like, and the spec would stay green for a token of any shape. It
 * is kept below as the first case because the key path is real coverage, but
 * the case that matters is the second: the token inside a verification URL
 * under an innocent key (`verifyUrl`, `link`, `href`), which is precisely the
 * object Task 5 builds and Tasks 8 and 10 log around.
 */
function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const logger = createLogger({ service: 'api', level: 'debug', pretty: false, stream });
  return { logger, lines };
}

describe('a minted secret token against the redacting logger', () => {
  it('does not survive under a key name the denylist knows', () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    logger.info({ token }, 'issued');
    expect(lines.join('')).not.toContain(token);
  });

  it('does not survive inside a verification URL under an innocent key', () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    logger.info(
      { verifyUrl: `https://app.sentinel.test/auth/verify?token=${token}` },
      'verification email queued',
    );
    expect(lines.join('')).not.toContain(token);
  });

  it('does not survive inside a reset URL in the message string itself', () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    logger.info(`sending https://app.sentinel.test/auth/reset?token=${token} to the mailer`);
    expect(lines.join('')).not.toContain(token);
  });

  it('does not survive as a trailing printf interpolation argument', () => {
    const { logger, lines } = captureLogger();
    const { token } = mintSecretToken();
    logger.info('reset link: %s', `https://app.sentinel.test/auth/reset?token=${token}`);
    expect(lines.join('')).not.toContain(token);
  });
});
