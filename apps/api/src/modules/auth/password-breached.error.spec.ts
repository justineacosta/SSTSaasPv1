import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';
import { PasswordBreachedError } from './password-breached.error.js';

describe('PasswordBreachedError', () => {
  it('is a 422 with the PASSWORD_BREACHED code', () => {
    // api/conventions.md §2: 422 is "valid shape, failed a domain rule". A 400
    // would file a policy refusal alongside a misspelled field name.
    const error = new PasswordBreachedError();
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(ERROR_CODES.PASSWORD_BREACHED);
    expect(error.status).toBe(422);
  });

  it('tells the user why and what to do instead', () => {
    // api/errors.md §4: a refusal that does not say how to succeed generates a
    // support ticket. security/authentication.md §2 requires the user be told.
    const { message } = new PasswordBreachedError();
    expect(message).toMatch(/breach/i);
    expect(message).toMatch(/different password/i);
  });

  it('carries nothing derived from the password', () => {
    // Critical security rule 6, and Ruling 3: not the password, not any part of
    // it, not its hash, not the five-character prefix. This text reaches a
    // browser and a 4xx log line.
    const error = new PasswordBreachedError();
    const rendered = JSON.stringify({
      message: error.message,
      details: error.details,
    });
    expect(rendered).not.toMatch(/[0-9a-f]{5,}/i);
  });
});
