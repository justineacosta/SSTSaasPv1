import { buildTokenLink } from './links.js';
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

export interface EmailVerificationInput extends TokenLinkInput {
  readonly recipientName: string;
}

export function renderEmailVerification(input: EmailVerificationInput): RenderedEmail {
  return renderEmail({
    subject: 'Confirm your email address',
    paragraphs: [
      `Hello ${input.recipientName},`,
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

export interface PasswordResetInput extends TokenLinkInput {
  readonly recipientName: string;
}

export function renderPasswordReset(input: PasswordResetInput): RenderedEmail {
  return renderEmail({
    subject: 'Reset your Sentinel password',
    paragraphs: [
      `Hello ${input.recipientName},`,
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

export interface InvitationInput extends TokenLinkInput {
  readonly inviterName: string;
  readonly organizationName: string;
}

/**
 * Task 15 owns the endpoint that sends this; the template is here because the
 * registry is where a seventh template inherits ruling 45's assertions, and
 * because §6's invitation TTL is already configured and would otherwise be a
 * value nothing reads.
 *
 * It addresses no one by name deliberately: an invitation is the one message
 * of the three whose recipient may have no `User` row at all, so there is no
 * display name to use.
 */
export function renderInvitation(input: InvitationInput): RenderedEmail {
  return renderEmail({
    subject: `You have been invited to ${input.organizationName} on Sentinel`,
    paragraphs: [
      `${input.inviterName} has invited you to join ${input.organizationName} on Sentinel.`,
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
