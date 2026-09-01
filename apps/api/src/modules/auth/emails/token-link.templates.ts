import { buildTokenLink } from './links.js';
import { sanitizeSubject } from '../../../infrastructure/mail/subject.js';
import { formatDuration, renderEmail, type RenderedEmail } from './layout.js';

/**
 * The three messages that carry a live credential.
 *
 * `security/authentication.md` §6 gives all three one discipline — 256-bit
 * random, hashed at rest, single-use, expiring, and **delivered only by email**
 * — which makes these three bodies the only place the raw token ever exists
 * outside the moment it was minted. That is why ruling 47 forbids the adapter
 * from logging a body, and why ruling 41 fixes the link shape: the token is the
 * password, for one use.
 *
 * Every one of them takes `ttlSeconds` rather than a sentence about the
 * lifetime. The TTLs are configuration so an operator can shorten one during an
 * incident (`packages/config/src/env.ts`), and a hand-written "one hour" keeps
 * claiming an hour after that has stopped being true.
 *
 * None of them names the recipient's address in the body. A reset message in
 * particular is the one an attacker triggers against an address they are
 * guessing at, and §6 requires the *response* not to reveal account existence;
 * repeating the address back in the body would leak the same thing to whoever
 * ends up reading the mail.
 */

interface TokenLinkInput {
  readonly webBaseUrl: string;
  readonly token: string;
  readonly ttlSeconds: number;
}

/**
 * NO `recipientName`, AND THE ABSENT FIELD IS THE CONTROL. F1.
 *
 * This message goes to an address whose ownership **nobody has proven** — that
 * is the entire reason it is being sent. The stored `User.name` on such a row is
 * not the recipient's name: anybody may `POST /auth/register` with somebody
 * else's address and a `name` of up to 200 characters of free text, and the
 * victim then receives this message greeting them with a stranger's sentence
 * and, if it contains one, a stranger's URL.
 *
 * The first version of the H1 fix closed that channel on `registrationAttempt`
 * and left it open here, and its own test excluded the field on the reasoning
 * that a display name is "the recipient's own". It is not, until the address is
 * verified — which is the thing this message exists to do.
 */
export type EmailVerificationInput = TokenLinkInput;

export function renderEmailVerification(input: EmailVerificationInput): RenderedEmail {
  return renderEmail({
    subject: 'Confirm your email address',
    paragraphs: [
      'Hello,',
      'Confirm this address to finish setting up your Sentinel account.',
      `This link can be used once and expires in ${formatDuration(input.ttlSeconds)}.`,
    ],
    action: {
      label: 'Confirm email address',
      url: buildTokenLink(input.webBaseUrl, 'emailVerification', input.token),
    },
    footer: [
      'You are receiving this because this address was used to register a Sentinel account.',
      'If that was not you, you can ignore this message and the address will not be confirmed.',
    ],
  });
}

/**
 * NO `recipientName`, AND THE ABSENT FIELD IS THE CONTROL. RULING 70, CLOSED.
 *
 * This is the template the ruling named, and it is the sharpest instance of the
 * defect in the codebase. Three facts stack:
 *
 * 1. `POST /auth/forgot-password` is **unauthenticated**, so anybody may aim
 *    this message at any address they can type.
 * 2. `User.name` is up to 200 characters of free text written straight from a
 *    registration body, and **an attacker seeds a victim's copy of it by
 *    registering the victim's address first** — the address then exists, so the
 *    victim's reset message greets them with the attacker's sentence and URL.
 * 3. Unlike every notice, this message carries a **live reset link**. So the
 *    injected text arrives beside a working credential, in a branded message
 *    the recipient has every reason to trust.
 *
 * The fix is the same structural one `emailVerification` took above and
 * `registrationAttempt` took in Task 8: the parameter is **gone**, not filtered.
 * A denylist over attacker text is a defect waiting for a new encoding; a field
 * that does not exist cannot be injected however a caller is edited later.
 *
 * Ruling 71's habit applies too — this is fixed to the CLASS, not to the
 * instance that happens to have a caller. `passwordChanged`, `mfaEnabled` and
 * `mfaDisabled` lost the same field in the same change although two of them
 * have no caller until Task 11. "Safe because it has no caller yet" is the
 * exact sentence Task 9 left standing over `newDeviceSignIn` in the commit that
 * gave it one.
 */
export type PasswordResetInput = TokenLinkInput;

export function renderPasswordReset(input: PasswordResetInput): RenderedEmail {
  return renderEmail({
    subject: 'Reset your Sentinel password',
    paragraphs: [
      // The unaddressed greeting the other two token-link templates already
      // use. See the type above.
      'Hello,',
      'Someone asked to reset the password on your Sentinel account. Use the link below to choose a new one.',
      `This link can be used once and expires in ${formatDuration(input.ttlSeconds)}. Resetting your password signs you out everywhere else.`,
    ],
    action: {
      label: 'Choose a new password',
      url: buildTokenLink(input.webBaseUrl, 'passwordReset', input.token),
    },
    footer: [
      // §6: the response must not reveal whether an account exists, and the
      // same reticence belongs in the body. This says what to do without
      // implying anything about who asked.
      'If you did not ask for this, no action is needed and your password stays as it is.',
      'Sentinel will never ask you for your password or a code by email or phone.',
    ],
  });
}

/**
 * NO `inviterName`, AND THE ABSENT FIELD IS THE CONTROL. M2 — RULING 70'S
 * FIFTH CHANNEL, AND IT WAS IN THE REGISTRY THIS TASK DECLARED CLOSED.
 *
 * `inviterName` was a stored `User.name`: the same 200 characters of free text
 * ruling 70 is about, chosen by somebody the recipient has never met, rendered
 * into a message that carries a **live token link**. The HTML part escaped it;
 * the **text** part did not, and mail clients autolink a bare URL in a
 * `text/plain` part — which is exactly how Task 8's H1 and Task 9's H2 were
 * rendered. That is four channels for one defect in three tasks, and this is
 * the fifth.
 *
 * It survived the round that closed ruling 70 because neither ruling-70 block
 * reached it: the whole-registry block sent the hostile payload through the
 * RECIPIENT's name only, and the hostile-everything block ran over
 * `NOTICE_TEMPLATE_IDS`, of which the invitation is not a member. So the one
 * template in the registry that actually rendered a stored display name was the
 * one template the payload was never run at. Ruling 58's family again.
 *
 * The field is gone rather than escaped, for the reason every previous round of
 * this defect converged on: a denylist over attacker text is a defect waiting
 * for a new encoding, and a parameter that does not exist is not. **Task 15
 * sends this message and does not need the inviter's stored name to do it.** If
 * it later decides it does, that is a decision made against this history rather
 * than a default inherited from a template nobody had run a hostile payload at.
 *
 * # `organizationName` STAYS, and it is a different case — but not a closed one
 *
 * An invitation that does not name the organisation is useless, and the value
 * belongs to an **accountable tenant** rather than to any anonymous registrant
 * who typed somebody else's address: creating an organisation requires an
 * authenticated, verified account, and the name is visible to every member.
 * That is a materially different threat from the one ruling 70 is about.
 *
 * **It is still caller-influenced text in a link-bearing message, and it is
 * still rendered into both parts and into the subject.** A tenant who puts a
 * URL in their organisation name gets it autolinked in the text part of every
 * invitation they send. That residual is real, it is recorded rather than
 * asserted away, and `registry.spec.ts` pins it from both sides so that closing
 * it turns a test red. **It binds Task 13**, which creates organisations and
 * owns whatever constraint the name carries, **and Task 15**, which ships the
 * endpoint that sends this message.
 */
export interface InvitationInput extends TokenLinkInput {
  readonly organizationName: string;
}

/**
 * Task 15 owns the endpoint that sends this; the template itself is built here,
 * in Task 5, so that it inherits ruling 45's assertions from the registry like
 * every other member, and because §6's invitation TTL is already configured and
 * would otherwise be a value nothing reads. It is a member of `EMAIL_TEMPLATES`
 * today, not a template Task 15 still has to add (M4, Task 5 review).
 *
 * It addresses no one by name deliberately: an invitation is the one message
 * of the three whose recipient may have no `User` row at all, so there is no
 * display name to use — and since M2 it names the **inviter** by no name
 * either. See `InvitationInput` above.
 */
export function renderInvitation(input: InvitationInput): RenderedEmail {
  // ONE LINE, ALWAYS — the sixth channel, closed at the render.
  //
  // `sanitizeSubject` already collapsed control characters on the way to the
  // SMTP header, so header injection was never open. What was open is the
  // **plain-text body**: the raw value carried CR and LF into it, so an
  // organisation name could forge whole paragraphs above the product's own
  // token link rather than merely contributing one autolinked URL. Reusing the
  // subject's sanitiser rather than writing a second rule, because two
  // implementations of "no control characters" drift.
  //
  // What this does NOT close, and Task 13 owns: a name that is a bare URL still
  // autolinks in the text part, and `Organization.name` has no length cap in
  // `schema.prisma` or in any Zod schema, so it is also unbounded. "Reject
  // URLs" would not be sufficient on its own.
  const organizationName = sanitizeSubject(input.organizationName);
  return renderEmail({
    subject: `You have been invited to ${organizationName} on Sentinel`,
    paragraphs: [
      // "Someone", not the inviter's stored display name. M2: that name is a
      // `User.name`, which is free text, and this message carries a live link.
      // The organisation is what the recipient needs in order to decide whether
      // the invitation is expected — the individual who clicked the button is
      // not, and Task 15 records them in the audit row instead.
      `You have been invited to join ${organizationName} on Sentinel.`,
      'Sentinel is a platform for managing authorised security testing, findings and reports.',
      `This invitation is for this address only and expires in ${formatDuration(input.ttlSeconds)}.`,
    ],
    action: {
      label: 'Accept the invitation',
      url: buildTokenLink(input.webBaseUrl, 'invitation', input.token),
    },
    footer: [
      'If you were not expecting this invitation, you can ignore this message.',
      'Sentinel will never ask you for your password or a code by email or phone.',
    ],
  });
}
