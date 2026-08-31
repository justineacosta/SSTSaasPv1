import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import type { Logger } from '@sentinel/observability';
import { ENV, LOGGER, MAILER } from '../../infrastructure/tokens.js';
import type { Mailer } from '../../infrastructure/mail/mailer.port.js';
import { EMAIL_TEMPLATES } from './emails/registry.js';
import { TokenService } from './token.service.js';

/**
 * The four messages the registration, verification and login endpoints send,
 * and the one place they decide what to do when a send fails.
 *
 * ## Every method here is called AFTER the transaction has committed
 *
 * Carry-forward ruling 44, and `mailer.port.ts`'s own docblock. A send inside
 * the transaction either holds it open across network I/O to a third party, or
 * tells someone "your account was created" about a creation that then rolled
 * back. An email cannot be recalled; a transaction can be. So nothing in this
 * class takes a transaction handle, which makes calling it from inside one an
 * awkward thing to write rather than an easy mistake to make — and
 * `registration.service.spec.ts` asserts the ordering rather than trusting it:
 * a transaction that throws must produce zero sends.
 *
 * ## A failed send does not change the response
 *
 * `send` raises (`smtp-mailer.ts`, ADR-0016) and is not retried and not queued
 * (carry-forward ruling 45). Both methods below swallow that failure and log
 * it, and this is a security decision rather than a convenience:
 *
 * - Registration's whole contract is that the response is identical whether or
 *   not the address exists. The existing-address path sends
 *   `registrationAttempt` and the new-address path sends `emailVerification`,
 *   so a raised send failure would be observable on **both** paths — but only
 *   for an address whose message the relay happened to reject, which is a
 *   difference an attacker can provoke (a mailbox that is full, a domain that
 *   greylists). A caller must not be able to turn a mail-transport outcome into
 *   an existence signal.
 * - Resend has the sharper version of the same problem: it sends only for an
 *   address that exists and is unverified, so a propagated failure would be a
 *   direct answer to "does this address exist".
 *
 * The cost is real and it is ruling 45's: the person whose verification email
 * was lost gets a 200 and no mail. `POST /auth/resend-verification` is their
 * remedy, and it is in this task precisely because of that.
 *
 * **What is NOT closed here.** A send that succeeds costs a round trip to the
 * relay and a send that never happens costs nothing, so `resend-verification`
 * still answers measurably faster for an address with no account. See
 * `email-verification.service.ts`.
 */
@Injectable()
export class AuthMailer {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The verification link, for a newly registered account or a resend.
   *
   * `token` is the raw secret `TokenService.issue` returned exactly once. It
   * goes into the link and nowhere else: not into the log line below, which
   * names only the template id, and not into the audit event.
   */
  async sendVerification(input: { to: string; token: string }): Promise<void> {
    // NO `recipientName`. F1: this message goes to an address nobody has
    // proven belongs to the recipient, so the stored display name may be text
    // an attacker chose when they registered that address. The parameter is
    // gone rather than sanitised, for the reason the H1 fix gives one method
    // down: a denylist over attacker text is a defect waiting for a new
    // encoding; a parameter that does not exist is not.
    const rendered = EMAIL_TEMPLATES.emailVerification({
      webBaseUrl: this.env.WEB_BASE_URL,
      token: input.token,
      // Read from the same configuration that stamped the expiry, so an
      // operator who shortens the TTL during an incident does not leave this
      // message claiming the old one.
      ttlSeconds: this.tokens.ttlSecondsFor('EMAIL_VERIFICATION'),
    });
    await this.deliver('emailVerification', input.to, rendered);
  }

  /**
   * The message an address that is already registered gets instead of a
   * verification link. Ruling B.
   */
  async sendRegistrationAttempt(input: { to: string; occurredAt: Date }): Promise<void> {
    // NO `ip` AND NO `userAgent`, AND THE SIGNATURE IS THE CONTROL. H1: the
    // caller of `POST /auth/register` chose those values and this message goes
    // to somebody else, so there must be no parameter for them to travel
    // through. `RegistrationAttemptContext` refuses them one layer down as
    // well. They are recorded in the `PlatformAuditEvent` row instead, which is
    // where attacker-supplied text belongs.
    const rendered = EMAIL_TEMPLATES.registrationAttempt({ occurredAt: input.occurredAt });
    await this.deliver('registrationAttempt', input.to, rendered);
  }

  /**
   * `security/authentication.md` §3's unfamiliar-session notice, sent after a
   * successful login from an IP and user agent this user's sessions have not
   * carried before.
   *
   * **The caller must not send this to an unverified address**, and the
   * signature cannot enforce that — `LoginService` does, and
   * `login.service.spec.ts` asserts it. What the signature *does* enforce is
   * ruling 70: there is no `recipientName` parameter, so no stored display name
   * can travel into a message this product sends, however the caller is edited
   * later.
   *
   * **NO `userAgent` PARAMETER, and the signature is the control.** H2, and it
   * supersedes ruling 63's carve-out — see `notice.templates.ts`'s
   * `NoticeOccurrenceContext`. This notice fires on an *unfamiliar* sign-in, so
   * on the takeover path the party who chose that header and the person reading
   * the message are different people, and the reviewer rendered a `Device:`
   * line carrying `https://sentinel-verify.evil.example/login` under a footer
   * promising the message contains no link. The parameter is gone rather than
   * sanitised, for the reason the H1 fix gave one method up: a denylist over
   * attacker text is a defect waiting for a new encoding.
   *
   * The IP stays and is the recipient's own. It is `request.ip` — the socket
   * peer address, `trust proxy` disabled — so a client cannot choose it and it
   * cannot carry a URL. It is `null`-able rather than defaulted, for
   * `notice.templates.ts`'s reason: a fabricated address in a security notice
   * is worse than an absent one.
   */
  async sendNewDeviceSignIn(input: {
    to: string;
    occurredAt: Date;
    ip: string | null;
  }): Promise<void> {
    const rendered = EMAIL_TEMPLATES.newDeviceSignIn({
      occurredAt: input.occurredAt,
      // `?? undefined`, because the template distinguishes "not recorded" from
      // a value and `null` is this codebase's word for the former at every
      // other boundary. The two spellings meet here and nowhere else.
      ipAddress: input.ip ?? undefined,
    });
    await this.deliver('newDeviceSignIn', input.to, rendered);
  }

  /**
   * §7's "a burst notifies the account owner", sent once per lock.
   *
   * **No IP and no user agent, and the signature is the control** — the same
   * shape `sendRegistrationAttempt` took for H1, applied to a message whose
   * context belongs to somebody else entirely. A burst is not the recipient's
   * session: the address that was guessing is not theirs, and the user agent is
   * a header that party chose. Both are recorded in the `PlatformAuditEvent`
   * row instead.
   *
   * `attemptCount` is `User.failedLoginCount`, a number this product computed.
   */
  async sendFailedLoginBurst(input: {
    to: string;
    occurredAt: Date;
    attemptCount: number;
  }): Promise<void> {
    const rendered = EMAIL_TEMPLATES.failedLoginBurst({
      occurredAt: input.occurredAt,
      attemptCount: input.attemptCount,
    });
    await this.deliver('failedLoginBurst', input.to, rendered);
  }

  private async deliver(
    templateId: string,
    to: string,
    rendered: { subject: string; html: string; text: string },
  ): Promise<void> {
    try {
      await this.mailer.send({ templateId, to, ...rendered });
    } catch (error) {
      // The recipient is logged and the body is not. `smtp-mailer.ts` already
      // logs the same pair at `error`; this line records that the failure was
      // deliberately absorbed rather than propagated, which is the part an
      // operator cannot infer from the adapter's line alone.
      this.logger.warn(
        { templateId, recipient: to, err: error },
        'email send failed and was not propagated to the caller',
      );
    }
  }
}
