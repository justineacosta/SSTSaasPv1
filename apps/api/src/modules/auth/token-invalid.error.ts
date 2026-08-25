import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * The one refusal a single-use token consumption can produce.
 *
 * **422, not 400 and not 401.** The request shape was valid — the value passed
 * `opaqueTokenSchema` — and it failed a domain rule, which is exactly what
 * `api/conventions.md` §2's status table reserves 422 for. The same reasoning
 * `PasswordBreachedError` records. It is not a 401 because nobody is
 * authenticating: an expired verification link is not a failed credential.
 *
 * **It does not say which refusal happened, and that is the whole design.**
 * Unknown token, expired token, already-consumed token and superseded token are
 * one code and one message. Three codes would turn the consume endpoint into an
 * account oracle: "expired" tells the caller the token once existed, which tells
 * them the address is registered, which is precisely what
 * `security/authentication.md` §6's "response is identical whether or not the
 * address exists" forbids. The forensic record of *which* it was belongs in the
 * `AuditEvent` the endpoint writes, where only an operator sees it.
 *
 * **No `details`.** `PasswordBreachedError` carries `{ reason: ... }` because
 * there is only one reason and naming it helps. Here a reason is the oracle,
 * so the field is absent rather than filled with a value that says nothing.
 *
 * Nothing raises this yet: Task 4 ships no endpoint. Email verification
 * (Task 8), password reset (Task 10) and invitation acceptance (Task 15) are
 * its callers, and `TokenService.consume` returning `null` is what they turn
 * into it.
 */
export class TokenInvalidError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.TOKEN_INVALID,
      'This link is no longer valid. Request a new one and use the most recent email.',
      422,
    );
    this.name = 'TokenInvalidError';
  }
}
