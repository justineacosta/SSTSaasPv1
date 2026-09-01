import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sentinel/observability';
import {
  CURRENT_MFA_SECRET_KEY_VERSION,
  decryptMfaSecret,
  encryptMfaSecret,
  generateTotpSecret,
} from './mfa-secret.js';

const key = Buffer.alloc(32, 0x2a);
const otherKey = Buffer.alloc(32, 0x2b);

describe('encryptMfaSecret / decryptMfaSecret', () => {
  it('round-trips a secret', () => {
    const secret = generateTotpSecret();
    const sealed = encryptMfaSecret(key, secret);
    expect(decryptMfaSecret(key, sealed.ciphertext, sealed.keyVersion)).toEqual(
      Buffer.from(secret),
    );
  });

  it('stamps every row with the current key version explicitly', () => {
    // Carry-forward ruling 8. The column existed from Task 1 and nothing wrote
    // it; NULL meant "whichever key was current". Task 11 writes it, which is
    // what turns a documented rotation story into a live code path.
    expect(encryptMfaSecret(key, generateTotpSecret()).keyVersion).toBe(
      CURRENT_MFA_SECRET_KEY_VERSION,
    );
    expect(CURRENT_MFA_SECRET_KEY_VERSION).toBe(1);
  });

  it('treats a NULL stored version as version 1', () => {
    // The rows Task 1 said could exist. There are none in any database, but the
    // decrypt path has to be able to read one or the migration story is a
    // comment rather than code.
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    expect(decryptMfaSecret(key, sealed.ciphertext, null)).toHaveLength(20);
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A random 12-byte IV per encryption. A fixed IV under GCM is catastrophic
    // — it leaks the XOR of two plaintexts and destroys the authenticator —
    // so this asserts the property rather than reading the code for it.
    const secret = generateTotpSecret();
    const seen = new Set(
      Array.from({ length: 32 }, () => encryptMfaSecret(key, secret).ciphertext),
    );
    expect(seen.size).toBe(32);
  });

  it('refuses a ciphertext whose body was tampered with', () => {
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    const parts = sealed.ciphertext.split('.');
    const body = Buffer.from(parts[3] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[3] = body.toString('base64url');
    expect(() => decryptMfaSecret(key, parts.join('.'), 1)).toThrow(/could not be decrypted/i);
  });

  it('refuses a ciphertext whose auth tag was tampered with', () => {
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    const parts = sealed.ciphertext.split('.');
    const tag = Buffer.from(parts[2] ?? '', 'base64url');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString('base64url');
    expect(() => decryptMfaSecret(key, parts.join('.'), 1)).toThrow(/could not be decrypted/i);
  });

  it('refuses a ciphertext whose IV was tampered with', () => {
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    const parts = sealed.ciphertext.split('.');
    const iv = Buffer.from(parts[1] ?? '', 'base64url');
    iv[0] = (iv[0] ?? 0) ^ 0xff;
    parts[1] = iv.toString('base64url');
    expect(() => decryptMfaSecret(key, parts.join('.'), 1)).toThrow(/could not be decrypted/i);
  });

  it('refuses the right ciphertext under the wrong key, rather than returning garbage', () => {
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    expect(() => decryptMfaSecret(otherKey, sealed.ciphertext, 1)).toThrow(
      /could not be decrypted/i,
    );
  });

  it.each([
    ['an empty string', ''],
    ['a value with too few parts', 'v1.aaaa.bbbb'],
    ['a value with too many parts', '1.a.b.c.d'],
    ['a non-numeric version', 'x.a.b.c'],
    ['plain text', 'not a ciphertext at all'],
  ])('refuses %s', (_label, value) => {
    expect(() => decryptMfaSecret(key, value, 1)).toThrow(/could not be decrypted/i);
  });

  it('refuses a version this process holds no key for', () => {
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    const parts = sealed.ciphertext.split('.');
    parts[0] = '2';
    expect(() => decryptMfaSecret(key, parts.join('.'), 2)).toThrow(/key version/i);
  });

  it('refuses a row whose column version disagrees with its envelope', () => {
    // Half-migrated: the re-encryption wrote the envelope and the column update
    // failed, or the reverse. Failing loudly is right — silently trusting one
    // of the two would decrypt with the wrong key and produce garbage that
    // looks like a secret.
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    expect(() => decryptMfaSecret(key, sealed.ciphertext, 7)).toThrow(/key version/i);
  });
});

describe('generateTotpSecret', () => {
  it('is 20 bytes, which is the HMAC-SHA1 block-aligned length RFC 4226 recommends', () => {
    expect(generateTotpSecret()).toHaveLength(20);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 16 }, () => generateTotpSecret().toString('hex')));
    expect(seen.size).toBe(16);
  });
});

/**
 * CRITICAL SECURITY RULE 6, MEASURED RATHER THAN ASSUMED.
 *
 * Written in the shape of `token.redaction.spec.ts`, which is the precedent in
 * this directory. The obvious version — `logger.info({ secret })` — proves
 * little: `SECRET_KEY_FRAGMENTS` in `packages/observability/src/redaction.ts`
 * matches on key names, so that object would be blanked whatever the value
 * looked like.
 *
 * **Carry-forward ruling 67 is the reason the cases below are shaped as they
 * are.** The redacting logger is a value-shape net, not a field-name denylist,
 * and neither `body` nor `text` is on the fragment list — so a base32 secret
 * logged under an innocent key is NOT rescued by the logger, and the assertion
 * that holds is the one about what this module puts in an error, not one about
 * what the logger would do with it.
 */
describe('the secret against the redacting logger and the error path', () => {
  function captureLogger() {
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

  it('does not survive under a key name the denylist knows', () => {
    const { logger, lines } = captureLogger();
    const secret = randomBytes(20).toString('base64url');
    logger.info({ mfaSecret: secret }, 'enrolled');
    expect(lines.join('')).not.toContain(secret);
  });

  it('is absent from the message and the stack of every refusal this module raises', () => {
    // The property that actually holds. A decryption failure derives from the
    // stored ciphertext and the key; neither may reach an operator's log or a
    // client's error body, and `MfaSecretError` carries a constant string.
    const sealed = encryptMfaSecret(key, generateTotpSecret());
    const parts = sealed.ciphertext.split('.');
    const body = Buffer.from(parts[3] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[3] = body.toString('base64url');
    const tampered = parts.join('.');

    try {
      decryptMfaSecret(key, tampered, 1);
      expect.unreachable('a tampered ciphertext must be refused');
    } catch (error) {
      const raised = error as Error;
      const rendered = `${raised.message}\n${raised.stack ?? ''}`;
      expect(rendered).not.toContain(tampered);
      expect(rendered).not.toContain(key.toString('base64'));
      expect(rendered).not.toContain(parts[3]);
    }
  });

  it('is not rescued by the logger under an innocent key, which is why nothing logs it', () => {
    // RULING 67, stated as a test so the next reader does not assume the
    // logger is a backstop here. A raw base32 secret under `label` survives.
    const { logger, lines } = captureLogger();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    logger.info({ label: secret }, 'not something this codebase does');
    expect(lines.join('')).toContain(secret);
  });
});
