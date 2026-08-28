import { formatUtcTimestamp, renderEmail, type RenderedEmail } from './layout.js';

/**
 * The messages that carry no token, and no link at all.
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
 * The one line every notice ends with, whatever it is about.
 *
 * Separated from `NOTICE_FOOTER` below because the advice above it is not
 * universal — see `renderRegistrationAttempt`, where "change your password
 * immediately" would be false advice about an event in which nothing changed.
 * This sentence is true of every message this product will ever send.
 */
const NOTICE_NEVER_ASKS =
  'Sentinel will never ask you for your password or a code by email or phone, and never includes a link in a security notice like this one.';

/**
 * The closing advice for a notice describing something that actually happened
 * to the account, and deliberately link-free.
 *
 * "Sign in and change your password" names an action the recipient performs by
 * going to the product the way they normally do, which is the only instruction
 * that stays safe when the message itself might be a forgery.
 */
const NOTICE_FOOTER = [
  'If this was not you, sign in to Sentinel the way you normally do and change your password immediately, then contact your organisation owner.',
  NOTICE_NEVER_ASKS,
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
 * THE EIGHTH TEMPLATE, AND THE OTHER HALF OF ENUMERATION RESISTANCE.
 *
 * `security/authentication.md` §7 requires registration to answer identically
 * for an address that exists and one that does not. That property is only half
 * a design on its own: the person who already has an account then learns
 * nothing about an attempt made against their address. This message is the
 * other half — the difference between the two paths lives in a mailbox the
 * account owner controls, and never on the wire.
 *
 * A NOTICE, not a token-link template. It carries no token, no link and no
 * action, so it belongs to `NOTICE_TEMPLATE_IDS` and inherits that list's
 * assertions: no `href`, no `http`, no `token`.
 *
 * **It does not name the address it was sent to.** The three token-link
 * templates already refuse to, and the argument is stronger here: this message
 * goes to an address someone *else* just typed into a registration form, and
 * the only thing an attacker learns from a bounce or a shared inbox should be
 * nothing.
 *
 * **It does not say "you already have an account" in the subject.** The subject
 * line is the part most likely to be visible on a lock screen over someone's
 * shoulder, and "someone tried to create an account with your address" is the
 * actionable half without being a membership disclosure to a bystander.
 */
export function renderRegistrationAttempt(context: SecurityNoticeContext): RenderedEmail {
  return renderEmail({
    subject: 'Someone tried to create a Sentinel account with your email address',
    paragraphs: [
      `Hello ${context.recipientName},`,
      'Someone submitted this email address to the Sentinel sign-up form. This address is already in use, so no second account was created and nothing about your existing account has changed.',
      'If it was you: you already have an account, so sign in instead. If you cannot remember your password, use the "forgot password" option on the sign-in page.',
      ...whereAndWhen(context),
    ],
    // NOT `NOTICE_FOOTER`. That footer tells the recipient to change their
    // password immediately, which is correct for a notice describing a change
    // to the account and false here: nothing happened, and sending people to
    // change a password because somebody typed their address into a form is
    // both wrong and a way to make this message worth triggering on purpose.
    footer: [
      'If this was not you, no action is needed. No account was created and your existing account is unchanged.',
      NOTICE_NEVER_ASKS,
    ],
  });
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
