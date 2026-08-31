import { ERROR_CODES } from '@sentinel/contracts';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * 403 `ACCOUNT_LOCKED`, AND IT IS RETURNED ONLY WHEN THE PASSWORD WAS RIGHT.
 *
 * **403, not 401**, per `api/authentication.md` §6. The Phase 2 plan calls this
 * out explicitly because it is easy to get wrong: 401 means "we do not know who
 * you are", and here we do — the caller has just proved it. What is being
 * refused is the *action*, which is what 403 is for.
 *
 * # The condition is the security control, not the status code
 *
 * D3. Answering this to *any* attempt on a locked account would hand an
 * enumeration oracle to precisely the caller who has just demonstrated they
 * will make five attempts: the response would confirm the address is
 * registered. So the password is verified first — always, against the dummy
 * hash when there is no account (carry-forward ruling 21) — and only then is
 * the lock consulted:
 *
 * | | locked | not locked |
 * |---|---|---|
 * | correct password | **this** (403) | a session |
 * | wrong password | `InvalidCredentialsError` (401) | `InvalidCredentialsError` (401) |
 * | no account | — | `InvalidCredentialsError` (401) |
 *
 * The top-left cell tells an attacker nothing they did not already have: to
 * reach it they need the password, and with the password they can simply wait
 * out the lock. It tells the real user the one thing they need, which is that
 * their password is fine and the account is temporarily unavailable.
 *
 * # Two different locks answer with this, deliberately
 *
 * `User.lockedUntil` is the temporary automatic brute-force lock and clears
 * itself; `User.status = LOCKED` (and `DISABLED`) is the separate
 * administrative one and does not. `schema.prisma` records that the two must
 * not be conflated *when reading* — a caller checking only `status` misses
 * every brute-force lock — but as a REFUSAL they are one answer, because a
 * second distinguishable outcome is a second thing a caller can learn by
 * submitting values. The message below is therefore true of both without
 * saying which.
 *
 * # The message does not name a duration
 *
 * `lockedUntil` is a real timestamp and putting it in the response would let a
 * caller measure the ladder, learn which rung an account is on, and therefore
 * how many failures it has accumulated — a fact about somebody else's account
 * activity. "Try again later" costs the legitimate user a little patience; the
 * exact instant costs the account owner their privacy.
 */
export class AccountLockedError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_LOCKED,
      'This account is temporarily locked. Try again later, or reset your password.',
      403,
    );
    this.name = 'AccountLockedError';
  }
}
