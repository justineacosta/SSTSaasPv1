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
 * address exists" forbids.
 *
 * **And no forensic record of which it was is written today.** This docblock
 * used to promise one, in "the `AuditEvent` the endpoint writes" — false twice
 * over as of Task 8, which is the task that gave this error its first caller.
 * The table would be `PlatformAuditEvent` (ADR-0019: a verification failure has
 * no organisation), and no event is written at all. The reason is structural
 * rather than an oversight: the audit write lives inside the same transaction
 * as the change, per `security/audit.md` §2, and every refusal here *throws*,
 * which rolls that transaction back and takes any event in it along. Recording
 * the failure means a second transaction after the rollback, which is a
 * different mechanism than the one this codebase has.
 *
 * `security/audit.md` §3 says failures and denials are audited, not only
 * successes, so this is a real gap and it is named rather than left to be
 * discovered. **Owed by whichever task builds the failure-audit path** — Task 9
 * meets the same problem first and harder, because a failed login is the single
 * most important failure event in the taxonomy.
 *
 * **No `details`.** `PasswordBreachedError` carries `{ reason: ... }` because
 * there is only one reason and naming it helps. Here a reason is the oracle,
 * so the field is absent rather than filled with a value that says nothing.
 *
 * **Task 8 gave it its first caller.** `EmailVerificationService.verify` raises
 * it at three sites: a token `consume` refused (itself four outcomes — unknown,
 * expired, consumed, superseded), a user row that has vanished, and an account
 * whose `status` is not `ACTIVE`. An earlier version of this sentence said
 * "four paths" and then listed three (F6). Password
 * reset (Task 10) and invitation acceptance (Task 15) are the remaining callers,
 * and `TokenService.consume` returning `null` is what each of them turns into it.
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
