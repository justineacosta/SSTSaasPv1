import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import type { Logger } from '@sentinel/observability';
import { ENV, LOGGER, MAILER } from '../../infrastructure/tokens.js';
import type { Mailer } from '../../infrastructure/mail/mailer.port.js';
import { EMAIL_TEMPLATES } from '../auth/emails/registry.js';
import { TokenService } from '../auth/token.service.js';

/**
 * THE ONE MESSAGE THIS MODULE SENDS.
 *
 * # Why it is not a tenth method on `AuthMailer`
 *
 * `AuthMailer` is deliberately **not** exported from `AuthModule`, and the
 * reason recorded there applies to this consumer as much as to any other: a
 * consumer holding the whole mailer could send a password-reset link, an
 * MFA-disabled notice or an unfamiliar-sign-in warning to any address it liked.
 * Adding a method there and then exporting the class to reach it would have
 * traded a recorded isolation decision for one import.
 *
 * The template is shared and this class is not a second copy of one:
 * `EMAIL_TEMPLATES.invitation` is `renderInvitation`, built in Task 5 and a
 * member of the registry since then, so it inherits every assertion in
 * `registry.spec.ts` — three non-empty parts, no unreplaced placeholder,
 * nothing that makes the recipient's client fetch from the network, and the
 * hostile-payload blocks. This file chooses the arguments; it renders nothing
 * itself.
 *
 * # The signature is the control, twice over
 *
 * **No display name.** Carry-forward rulings 70 and 85, and this template is
 * where that defect's fifth channel lived: `renderInvitation` used to take an
 * `inviterName` — a stored `User.name`, 200 characters of free text chosen by
 * somebody the recipient has never met — and render it into the **text** part of
 * a message carrying a live token link, where mail clients autolink a bare URL.
 * It accepts no such parameter now, and neither does this method, so there is no
 * path from a stored row into the body. The inviter is recorded in the
 * `MEMBER_INVITED` audit row, which an operator reads.
 *
 * **`organizationName` is the residual, and it is characterised rather than
 * closed.** Carry-forward ruling 86. It is caller-influenced text in a
 * link-bearing message and it is rendered into both parts and the subject.
 * `renderInvitation` runs it through `sanitizeSubject`, which shuts the CR/LF
 * half — a name could otherwise forge whole paragraphs above the product's own
 * link. What remains is that a bare URL in an organisation's name still
 * autolinks in the text part, and `Organization.name` has no length cap in
 * `schema.prisma` or in any Zod schema. Ruling 86 binds Task 13 for the cap;
 * this task sends the message and does not close it. It is a materially
 * different threat from ruling 70's: creating an organisation needs an
 * authenticated, verified account, and the name is visible to every member.
 *
 * # A failed send is swallowed, and the caller's response does not change
 *
 * Carry-forward ruling 45, and the same decision `AuthMailer` records. `send`
 * raises (`smtp-mailer.ts`, ADR-0016) and is not retried and not queued. The
 * cost here is real and it is small relative to the other templates': the
 * invitation is a credential nobody has yet, its remedy is to invite the address
 * again, and re-inviting **supersedes** rather than duplicating (D4), so the
 * remedy leaves exactly one live invitation. Propagating the failure instead
 * would roll nothing back — the transaction has already committed — and would
 * answer 500 for an invitation that exists.
 */
@Injectable()
export class InvitationMailerAdapter {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * `token` is the raw secret `mintSecretToken` returned exactly once. It goes
   * into the link `renderInvitation` builds and nowhere else: not into the row
   * beside its hash, not into the log line below, which names only the template
   * id and the recipient, and not into the `MEMBER_INVITED` audit event.
   */
  async send(input: { to: string; token: string; organizationName: string }): Promise<void> {
    const rendered = EMAIL_TEMPLATES.invitation({
      webBaseUrl: this.env.WEB_BASE_URL,
      token: input.token,
      organizationName: input.organizationName,
      // Read from the same configuration that stamped `Invitation.expiresAt`,
      // so an operator who shortens the TTL during an incident does not leave
      // this message claiming the old one.
      ttlSeconds: this.tokens.ttlSecondsFor('INVITATION'),
    });

    try {
      await this.mailer.send({ templateId: 'invitation', to: input.to, ...rendered });
    } catch (error) {
      // The recipient is logged and the body is not. `smtp-mailer.ts` already
      // logs the same pair at `error`; this line records that the failure was
      // deliberately absorbed rather than propagated, which is the part an
      // operator cannot infer from the adapter's line alone.
      this.logger.warn(
        { templateId: 'invitation', recipient: input.to, err: error },
        'email send failed and was not propagated to the caller',
      );
    }
  }
}
