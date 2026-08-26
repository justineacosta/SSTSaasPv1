/**
 * The port every caller depends on, and the only thing they are allowed to know
 * about how mail leaves this process.
 *
 * ADR-0016. One port, one adapter, and that adapter speaks SMTP. The Resend
 * HTTP adapter is deferred until the first staging deploy, because that is the
 * first moment an API key and a verified sending domain exist and therefore the
 * first moment such an adapter could be *run* rather than merely written. Adding
 * it is a second class behind this interface and a factory that chooses between
 * them; no template and no caller changes.
 *
 * ## Sending happens after commit, outside the transaction
 *
 * **This is a rule about callers, and in this task it can only be a written
 * contract — no endpoint exists yet to demonstrate it.** Ruling 51. Tasks 8,
 * 10, 11 and 15 are bound by it, and it is stated here rather than in a
 * document because this docblock is what those tasks will actually read.
 *
 * The alternative — `send()` inside the transaction that made the change — was
 * rejected on the second of its two problems, not the first. The first is that
 * it holds a database transaction open across network I/O to a third party,
 * which is a latency and lock-duration problem and would be survivable. The
 * second is not: a transaction can roll back, and an email cannot. A send
 * inside the transaction that rolls back has already told a user "your password
 * was changed" about a change that did not happen — a security notice
 * describing an event that never occurred, which is worse than no notice at
 * all, because it trains the recipient to ignore the real one. An email is not
 * transactional and cannot be recalled.
 *
 * So: write the row and its audit event in the transaction, commit, then send.
 * `development/coding-standards.md` §7 states the same rule for every side
 * effect (queue, email, webhook, realtime).
 *
 * The consequence is that a send can fail after the change is committed, and
 * ADR-0016 names that as a real gap rather than an oversight: a failed send in
 * Phase 2 raises and is logged, it is not retried and it is not queued. For a
 * verification email that is survivable because Task 8 must ship a resend path
 * anyway. For a notice email it means the security signal never arrives and
 * nothing detects that. Phase 4 brings BullMQ and mail delivery belongs on it.
 */

export interface OutgoingMail {
  /**
   * Which template produced this message — `'emailVerification'`,
   * `'mfaDisabled'`, and so on.
   *
   * Required rather than optional, and this is a deliberate refinement of
   * ADR-0016's `send({ to, subject, html, text })`. Ruling 47 has the adapter
   * log the template id and forbids it from logging any part of the body, so
   * the id is the *only* thing an operator has to go on when asking whether a
   * given notice was sent. An optional field is a field the first caller
   * forgets, and the log line it produces then says nothing.
   */
  readonly templateId: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface SentMail {
  /** As the receiving server reported it. Useful for correlating with relay logs. */
  readonly messageId: string;
}

export interface Mailer {
  /**
   * Delivers one message. Raises if the transport refuses it; see the gap named
   * in this file's docblock.
   */
  send(mail: OutgoingMail): Promise<SentMail>;
}
