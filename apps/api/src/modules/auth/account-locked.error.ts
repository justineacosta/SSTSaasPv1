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
 * # The message must be TRUE OF BOTH, and it was not
 *
 * L5. It used to read *"This account is temporarily locked. Try again later, or
 * reset your password."* For an administratively disabled account all three
 * clauses are false: it is not temporary, trying again later will never work,
 * and resetting the password will not help. The reasoning that produced it was
 * about what an *operator* could infer from the response and never asked what
 * the *user* was being told.
 *
 * Non-disclosure achieved by lying to the legitimate user is a worse trade than
 * a vaguer sentence, so the message is now true of both kinds of lock and
 * distinguishes neither. It names no duration and no cause: `lockedUntil` is a
 * real timestamp, and returning it would let a caller measure which rung of the
 * ladder an account is on and therefore how many failures it has accumulated —
 * a fact about somebody else's account activity. It points at the one route
 * that is correct in both cases, which is asking the people who can actually
 * change the state.
 */
export class AccountLockedError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_LOCKED,
      'This account cannot be signed in to at the moment. If this is unexpected, contact your organisation owner or Sentinel support.',
      403,
    );
    this.name = 'AccountLockedError';
  }
}
