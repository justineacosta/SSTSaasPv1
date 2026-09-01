import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * THE ONE REFUSAL THE MFA CHALLENGE GIVES FOR EVERY WAY IT CAN FAIL.
 *
 * `api/authentication.md` §6: 401 `MFA_INVALID`. Seven distinct situations
 * reach it and a caller cannot tell them apart:
 *
 * - the pending token is unknown, expired or revoked;
 * - the token resolves to a session that is not `PENDING_MFA`;
 * - the account has no confirmed factor;
 * - the submitted code is not a valid TOTP code for this factor;
 * - the code IS valid but has already been used — the replay floor (D6);
 * - the submitted value is a recovery code that matches nothing, or one that
 *   has already been spent;
 * - the promotion was refused because the account's password was replaced
 *   after the pending session was created (D4).
 *
 * The last is the one worth stating explicitly. It is a *different* failure
 * from a wrong code and the caller gets the same bytes for it, deliberately:
 * telling somebody "your code was right but the password changed" hands a
 * useful fact to whoever is holding a password they should no longer have.
 * `login.service.ts` makes the same choice on the same race.
 *
 * **No `details`, and the message names nothing.** A `{ reason: 'replayed' }`
 * would tell an attacker who observed a code over a shoulder that they had the
 * right value and merely arrived second, which is exactly the fact the replay
 * defence exists to make useless.
 */
export class MfaInvalidError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.MFA_INVALID,
      'That code is not valid. Enter a fresh code from your authenticator app, or one of your recovery codes.',
      401,
    );
    this.name = 'MfaInvalidError';
  }
}

/**
 * Enrolment refused because a **confirmed** factor already exists. D3.
 *
 * 409 `DUPLICATE_RESOURCE` per `api/conventions.md` §2's status table.
 *
 * It is a refusal rather than a silent overwrite, and that is the security half
 * of ruling 7's fix: replacing an *unconfirmed* factor is what stops an
 * abandoned enrolment locking the user out forever, and replacing a
 * *confirmed* one without proving a code would let somebody holding a stolen
 * session swap the account's second factor for their own — an account-takeover
 * step wearing a settings edit's clothes.
 *
 * The message says how to succeed, per `api/errors.md` §4: disable the existing
 * factor first, which costs the current password.
 */
export class MfaAlreadyEnabledError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.DUPLICATE_RESOURCE,
      'Two-factor authentication is already switched on for this account. Turn it off before setting it up again.',
      409,
    );
    this.name = 'MfaAlreadyEnabledError';
  }
}

/**
 * Confirmation, disabling or regeneration attempted when there is nothing in
 * that state to act on.
 *
 * 422 `INVALID_STATE_TRANSITION`, which is `api/conventions.md` §2's own
 * example for that status: "valid shape, failed a domain rule (e.g. invalid
 * status transition)". The request is well-formed and the caller is
 * authenticated; the account is simply not in a state where the action means
 * anything. **409 belongs to the error above** — a duplicate — and the status
 * table separates the two deliberately. It covers "confirm with no enrolment in progress" and "disable or
 * regenerate with no confirmed factor" with one code, because the two are the
 * same fact from opposite directions and neither discloses anything a caller
 * holding the session does not already know.
 */
export class MfaNotEnabledError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      'Two-factor authentication is not set up on this account.',
      422,
    );
    this.name = 'MfaNotEnabledError';
  }
}
