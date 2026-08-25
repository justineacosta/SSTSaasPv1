import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { TokenInvalidError } from './token-invalid.error.js';
import { mintSecretToken } from './secret-token.js';

describe('TokenInvalidError', () => {
  it('is a 422 with the TOKEN_INVALID code', () => {
    // api/conventions.md §2: 422 is "valid shape, failed a domain rule". The
    // token passed opaqueTokenSchema; it simply is not redeemable. Same
    // reasoning PasswordBreachedError records.
    const error = new TokenInvalidError();
    expect(error).toBeInstanceOf(DomainError);
    // The literal first, then the constant. Asserting only
    // `toBe(ERROR_CODES.TOKEN_INVALID)` is a test that passes while the code
    // does not exist at all: both sides read `undefined` from a stale build of
    // @sentinel/contracts and match. That happened on the first run of this
    // spec, before the constant reached the package's dist — the same "green
    // under a real violation" shape as Task 2's and Task 3's Medium findings.
    expect(error.code).toBe('TOKEN_INVALID');
    expect(ERROR_CODES.TOKEN_INVALID).toBe('TOKEN_INVALID');
    expect(error.status).toBe(422);
  });

  it('does not say which of the four refusals happened', () => {
    // Ruling 7. Unknown, expired, already consumed and superseded are one code
    // and one message. "Expired" would confirm the token once existed, which
    // confirms the address is registered — exactly what §6's "response is
    // identical whether or not the address exists" forbids.
    const { message, details } = new TokenInvalidError();
    const rendered = JSON.stringify({ message, details });
    for (const word of ['expire', 'consum', 'used', 'supersede', 'unknown', 'exist', 'found']) {
      expect(rendered.toLowerCase()).not.toContain(word);
    }
  });

  it('tells the user how to succeed anyway', () => {
    // api/errors.md §4: a refusal that does not say what to do next generates a
    // support ticket. "Request a new link" is actionable without being an
    // oracle — it is the same advice in all four cases.
    expect(new TokenInvalidError().message).toMatch(/request a new/i);
  });

  it('carries nothing derived from the token', () => {
    // Critical security rule 6. The message reaches a browser and a 4xx log
    // line, and the token is a password reset in the wrong hands.
    const { token, tokenHash } = mintSecretToken();
    const error = new TokenInvalidError();
    const rendered = JSON.stringify({ message: error.message, details: error.details });
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(tokenHash);
    // Nothing base64url-shaped or hex-shaped at all, so a later edit cannot
    // slip a fragment of one in.
    expect(rendered).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});
