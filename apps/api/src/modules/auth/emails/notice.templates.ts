import { formatUtcTimestamp, renderEmail, type RenderedEmail } from './layout.js';

/**
 * The three messages that carry no token, and no link at all.
 *
 * These exist for one reason: **so that an account takeover is visible to its
 * victim.** `security/authentication.md` §2 requires an email on password
 * change and reset, §5 on enabling or disabling MFA, and §7 that a burst of
 * failed logins notifies the account owner. An attacker who has taken an
 * account can change its password and turn off its second factor; what they
 * cannot do is un-send the message that says so.
 *
 * **None of them contains a link, and `registry.spec.ts` asserts that.** It is
 * a stronger property than "carries no token" and it is the one worth having.
 * A security notice is exactly the message a phisher wants to imitate — "your
 * password was changed, click here if this wasn't you" is the entire pretext —
 * so a product whose real notices never contain a link has taught its users
 * that a notice asking them to click is fake. It also removes any chance of a
 * future edit dropping a credential into one of these bodies. The cost is real
 * and accepted: the recipient has to navigate to the product themselves.
 *
 * The context fields are all attacker-influenced. `ipAddress` comes from the
 * connection and `userAgent` is a request header the client chooses outright,
 * so both reach `escapeHtml` like everything else. They are optional because a
 * caller must never invent them: "unknown" is honest and a fabricated address
 * in a security notice is worse than an absent one.
 */

export interface SecurityNoticeContext {
  readonly recipientName: string;
  readonly occurredAt: Date;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

const UNKNOWN = 'not recorded';

function whereAndWhen(context: SecurityNoticeContext): readonly string[] {
  return [
    `When: ${formatUtcTimestamp(context.occurredAt)}`,
    `IP address: ${context.ipAddress ?? UNKNOWN}`,
    `Device: ${context.userAgent ?? UNKNOWN}`,
  ];
}

/**
 * The closing advice, shared by all three and deliberately link-free.
 *
 * "Sign in and change your password" names an action the recipient performs by
 * going to the product the way they normally do, which is the only instruction
 * that stays safe when the message itself might be a forgery.
 */
const NOTICE_FOOTER = [
  'If this was not you, sign in to Sentinel the way you normally do and change your password immediately, then contact your organisation owner.',
  'Sentinel will never ask you for your password or a code by email or phone, and never includes a link in a security notice like this one.',
] as const;

export function renderPasswordChanged(context: SecurityNoticeContext): RenderedEmail {
  return renderEmail({
    subject: 'Your Sentinel password was changed',
    paragraphs: [
      `Hello ${context.recipientName},`,
      'The password on your Sentinel account was changed. Every other session was signed out.',
      ...whereAndWhen(context),
    ],
    footer: [...NOTICE_FOOTER],
  });
}

/**
 * Both MFA states from one renderer, exposed as two registry entries.
 *
 * The wording differs by more than a word: enabling is reassurance and mentions
 * recovery codes, disabling is a warning, and the disabling notice is the one
 * that matters — an attacker who has taken an account turns the second factor
 * off, and this message is what tells its owner.
 */
export type MfaChange = 'enabled' | 'disabled';

const MFA_COPY: Readonly<Record<MfaChange, { subject: string; body: readonly string[] }>> = {
  enabled: {
    subject: 'Two-factor authentication was enabled on your Sentinel account',
    body: [
      'Two-factor authentication is now switched on for your Sentinel account. You will be asked for a code from your authenticator app when you sign in.',
      'Keep your recovery codes somewhere safe. They are the only way back in if you lose the device.',
    ],
  },
  disabled: {
    subject: 'Two-factor authentication was disabled on your Sentinel account',
    body: [
      'Two-factor authentication has been switched off for your Sentinel account. Your account is now protected by its password alone.',
      'Any recovery codes issued previously no longer work.',
    ],
  },
};

export interface MfaChangedInput extends SecurityNoticeContext {
  readonly change: MfaChange;
}

export function renderMfaChanged(input: MfaChangedInput): RenderedEmail {
  const copy = MFA_COPY[input.change];
  return renderEmail({
    subject: copy.subject,
    paragraphs: [`Hello ${input.recipientName},`, ...copy.body, ...whereAndWhen(input)],
    footer: [...NOTICE_FOOTER],
  });
}

/**
 * Bound discriminators rather than one registry entry taking an argument.
 *
 * Ruling 47 has the adapter log the template id and nothing from the body, so
 * the id is all an operator reading logs has to go on — and "MFA was turned
 * off" is the security-relevant half of this pair. One `mfaChanged` id would
 * make the two indistinguishable in exactly the place where the difference
 * matters, and it would give ruling 45's table only one of the two states.
 */
export function renderMfaEnabled(context: SecurityNoticeContext): RenderedEmail {
  return renderMfaChanged({ ...context, change: 'enabled' });
}

export function renderMfaDisabled(context: SecurityNoticeContext): RenderedEmail {
  return renderMfaChanged({ ...context, change: 'disabled' });
}

/**
 * §7's "a burst notifies the account owner". Task 9 owns the burst detection
 * and therefore owns deciding what counts as a new device; this is the message
 * it sends when it does.
 */
export function renderNewDeviceSignIn(context: SecurityNoticeContext): RenderedEmail {
  return renderEmail({
    subject: 'New sign-in to your Sentinel account',
    paragraphs: [
      `Hello ${context.recipientName},`,
      'Your Sentinel account was signed in to from a device we have not seen before.',
      ...whereAndWhen(context),
    ],
    footer: [...NOTICE_FOOTER],
  });
}
