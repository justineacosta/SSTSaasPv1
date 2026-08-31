import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * THE ONE REFUSAL LOGIN GIVES FOR EVERY WAY A CREDENTIAL CAN BE WRONG.
 *
 * `api/authentication.md` §6: 401 `INVALID_CREDENTIALS`. Five distinct
 * situations reach it, and the whole design is that a caller cannot tell them
 * apart:
 *
 * - the address has no account at all;
 * - the account exists and the password is wrong;
 * - the account exists and has no `Credential` row;
 * - the stored credential is corrupt and Argon2 refuses to read it
 *   (carry-forward ruling 25 — the operator gets an `error` log line, the
 *   caller gets this);
 * - the account is temporarily locked *and* the password was also wrong (D3).
 *
 * The fifth is the interesting one. A locked account with a **correct**
 * password gets `AccountLockedError` instead, because that caller has already
 * proved they hold the password and needs to be told why it is not working. A
 * locked account with a wrong password gets this, byte for byte identical to
 * every other failure — otherwise the response would confirm the address is
 * registered to exactly the caller who has just demonstrated they will make
 * five attempts.
 *
 * **No `details`, and the message names nothing.** `security/authentication.md`
 * §7 requires login to answer without distinguishing existing from
 * non-existing accounts, and a `details` field is where that promise usually
 * dies: a `{ reason: 'wrong_password' }` is an existence oracle in a key nobody
 * reads until it ships.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(ERROR_CODES.INVALID_CREDENTIALS, 'Email address or password is incorrect.', 401);
    this.name = 'InvalidCredentialsError';
  }
}
