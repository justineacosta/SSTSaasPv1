import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * The refusal raised when the breach check confirms a match.
 *
 * **422, not 400.** The request shape was valid; the value failed a domain rule
 * — `api/conventions.md` §2's status table reserves 422 for exactly that.
 * Filing it as a 400 would put a policy refusal in the same bucket as a
 * misspelled field name.
 *
 * **The message says how to succeed**, per `api/errors.md` §4, because
 * `security/authentication.md` §2 requires the user be told why. It names the
 * reason — the password appears in a public breach corpus — and asks for a
 * different one.
 *
 * **Nothing derived from the password appears in the message or the details.**
 * Not the password, not any part of it, not its SHA-1, not the five-character
 * prefix. This text is rendered to a browser and logged as a 4xx by
 * `AllExceptionsFilter`.
 *
 * Nothing raises this yet: Task 3 ships no endpoint. Registration (Task 8),
 * password change (Task 9) and password reset (Task 10) are its callers.
 */
export class PasswordBreachedError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.PASSWORD_BREACHED,
      'This password has appeared in a public data breach, so it cannot be used here. ' +
        'Choose a different password — ideally one you have never used on another site.',
      422,
      { reason: 'FOUND_IN_BREACH_CORPUS' },
    );
    this.name = 'PasswordBreachedError';
  }
}
