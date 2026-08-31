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

/**
 * The two lines `whereAndWhen` renders, split out from the greeting.
 *
 * Separate from `SecurityNoticeContext` because Task 9 introduced the first
 * notice that renders the context block and **no** display name
 * (`newDeviceSignIn`). Composing the block out of a narrower type is what lets
 * that template drop `recipientName` from its own context without inventing a
 * fake one to satisfy this function's parameter.
 *
 * # THERE IS NO `userAgent` FIELD, AND THAT SUPERSEDES RULING 63
 *
 * Ruling 63's rule is *a message this product sends to one person must never
 * render text a different person chose.* It licensed a `Device:` line on four
 * notices with a carve-out: *"there it describes the recipient's own session"*.
 *
 * **That carve-out is withdrawn, deliberately, and this is the third finding it
 * produced in three tasks** — Task 8's H1 (`registrationAttempt` rendering the
 * caller's `User-Agent`), Task 8's F1 (the display name through the same
 * template), and Task 9's H2. H2 is the case the carve-out's reasoning did not
 * consider: `newDeviceSignIn` fires on an *unfamiliar* sign-in, so on the
 * takeover path the recipient and the chooser are **different people** — which
 * is precisely the condition ruling 63's own sentence forbids. The reviewer
 * rendered it from the built module: a `Device:` line carrying
 * `https://sentinel-verify.evil.example/login`, under a footer promising the
 * message contains no link, aimed at the victim of the takeover the message
 * exists to warn them about. Repeatable, too: familiarity is exact-match on the
 * user agent, so varying it produces a fresh notice every time.
 *
 * A rule with an exception that has produced three findings in three tasks is
 * not a rule with an exception; it is a rule nobody is following. The field is
 * gone rather than filtered, for the reason the H1 fix gives: a denylist over
 * attacker text is a defect waiting for a new encoding, and a parameter that
 * does not exist is not.
 *
 * # `IP address:` stays, and the difference is not a matter of degree
 *
 * `ip` is `request.ip` — Express's socket peer address, with `trust proxy`
 * disabled (`request-context.ts`), bounded to 45 characters and set to NULL
 * rather than truncated when it does not fit (`session.service.ts`). It is not
 * free text: a client cannot choose it, it cannot carry a URL or a sentence,
 * and it is the one line in the block a recipient can actually act on. A user
 * agent is a request header the client picks outright, up to 512 characters.
 *
 * The user agent is not discarded — it goes in the `PlatformAuditEvent` row,
 * which is where attacker-supplied text belongs: read by an operator, in an
 * append-only table built for exactly that, never rendered into a message sent
 * to somebody else.
 */
export interface NoticeOccurrenceContext {
  readonly occurredAt: Date;
  readonly ipAddress?: string | undefined;
}

export interface SecurityNoticeContext extends NoticeOccurrenceContext {
  readonly recipientName: string;
}

const UNKNOWN = 'not recorded';

/**
 * An IPv4 or IPv6 literal, and nothing else, may be rendered as an address.
 *
 * **This exists because the reason for keeping `IP address:` was a claim about
 * today's caller rather than a property of the code.** H2's disposition kept
 * the line on the grounds that "a socket peer address is not free text, cannot
 * carry a URL, and is bounded and validated already". The first half is true of
 * `request.ip` with `trust proxy` disabled; the second half was not true
 * anywhere between that read and this line. `AuthMailer.sendNewDeviceSignIn`
 * accepted `ip: string | null` and this function rendered whatever it was
 * handed — measured against the built module: passing a URL as `ipAddress`
 * produced a link in all four context-rendering notices, `newDeviceSignIn`
 * included, under the footer promising there is none.
 *
 * That is carry-forward ruling 22's shape — a decision that is right with a
 * reason beside it that is false — and it is what ruling 63's withdrawn
 * carve-out was too. So the claim is enforced rather than asserted: a value
 * that is not an address is rendered as `not recorded`, which is the same
 * honest answer an absent one gets.
 *
 * Deliberately a **shape** check and not a parser. It does not need to accept
 * every legal address or reject every illegal one; it needs to make it
 * impossible for this line to carry a sentence, a URL, or markup. Hex digits,
 * dots and colons cannot form a scheme, an `href`, or a tag.
 */
const IP_LITERAL = /^[0-9a-fA-F.:]{3,45}$/;

function renderableIpAddress(value: string | undefined): string {
  if (value === undefined) return UNKNOWN;
  return IP_LITERAL.test(value) ? value : UNKNOWN;
}

function whereAndWhen(context: NoticeOccurrenceContext): readonly string[] {
  return [
    `When: ${formatUtcTimestamp(context.occurredAt)}`,
    `IP address: ${renderableIpAddress(context.ipAddress)}`,
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
 * What `registrationAttempt` may be told, and it is deliberately narrower than
 * `SecurityNoticeContext`.
 *
 * H1. `whereAndWhen` renders `Device: <userAgent>`, and on this one template the
 * user agent belongs to **a stranger**: `POST /auth/register` against an address
 * that already exists mails this notice to the account owner, and the caller
 * chose that header. Rendering it put up to 512 characters of attacker-supplied
 * text — a sentence, a URL — into a message wearing this product's branding,
 * under a footer promising it contains no link.
 *
 * The type is the fix, not a filter. A denylist over attacker text is a defect
 * waiting for a new encoding; a parameter that cannot carry the value is not.
 * `AuthMailer.sendRegistrationAttempt` no longer accepts an IP or a user agent
 * either, so there is no path from the request to this template at all.
 *
 * **The values are not discarded — they go in the `PlatformAuditEvent` row.**
 * That is where attacker-supplied text is supposed to end up: read by an
 * operator, in an append-only table built for exactly this, never rendered into
 * a message sent to somebody else.
 */
export type RegistrationAttemptContext = Pick<NoticeOccurrenceContext, 'occurredAt'>;

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
 * **It names nobody.** Not the address, not a display name. F1: the first
 * version of this fix dropped the device and the IP and kept `recipientName`,
 * on the reasoning that a display name is the recipient's own — but an attacker
 * seeds it by registering the victim's address first, with up to 200 characters
 * of free text in `name`. The greeting then carried the same injected sentence
 * and URL that the device line had, under the same footer promising no link.
 * A field that cannot be passed cannot be injected.
 *
 * **It names no device and no IP address.** Every other notice does, because
 * there the string describes an action the recipient's own authenticated
 * session took and is how they recognise a session that is not theirs. Here it
 * describes the stranger who typed their address into a form, and the recipient
 * has no session of their own to compare it against — so it is not context, it
 * is a message from somebody else printed inside our envelope. H1.
 *
 * **It does not say "you already have an account" in the subject.** The subject
 * line is the part most likely to be visible on a lock screen over someone's
 * shoulder, and "someone tried to create an account with your address" is the
 * actionable half without being a membership disclosure to a bystander.
 */
export function renderRegistrationAttempt(context: RegistrationAttemptContext): RenderedEmail {
  return renderEmail({
    subject: 'Someone tried to create a Sentinel account with your email address',
    paragraphs: [
      'Hello,',
      'Someone submitted this email address to the Sentinel sign-up form. This address is already in use, so no second account was created and nothing about your existing account has changed.',
      'If it was you: you already have an account, so sign in instead. If you cannot remember your password, use the "forgot password" option on the sign-in page.',
      // The timestamp only — NOT `whereAndWhen(context)`, which is the other
      // four notices' block and carries the caller's IP and user agent. See
      // `RegistrationAttemptContext` above. The clock reading is ours, so it
      // stays: dropping the whole block would have cost the recipient the one
      // piece of context they can actually use.
      `When: ${formatUtcTimestamp(context.occurredAt)}`,
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
 * What `newDeviceSignIn` may be told, and it lost `recipientName` in Task 9.
 *
 * **Ruling 70, applied one template further than the ruling itself demanded.**
 * The ruling's rule is that a message to an address whose ownership has not
 * been proven must render no stored display name, and this message *is* sent
 * only to a proven address — `AuthMailer.sendNewDeviceSignIn` is called only
 * when `User.emailVerifiedAt` is non-null, and `login.service.spec.ts` asserts
 * that. So the ruling does not strictly reach it.
 *
 * The parameter is dropped anyway, because the cost of keeping it is the whole
 * attack surface and the benefit is a greeting. `User.name` is 200 characters
 * of free text written straight from a registration body; the moment somebody
 * decides an unverified account may also receive this notice — which is a
 * one-line change in a service, not a change to this file — the injection is
 * live again with no test to catch it. A parameter that does not exist cannot
 * be reintroduced by a caller's edit. This is the same structural fix
 * `emailVerification` and `registrationAttempt` took, and `registry.spec.ts`'s
 * `NO_DISPLAY_NAME_TEMPLATE_IDS` partition is what holds it.
 *
 * **The IP and the user agent stay**, and that is ruling 63's licensed side of
 * the partition: for a verified address this message describes the recipient's
 * *own* new session, and the device string is exactly how they recognise one
 * that is not theirs. Both still pass through `escapeHtml` like every other
 * interpolated value, and the residual `registry.spec.ts` records for the
 * context-rendering notices applies here unchanged.
 */
export type NewDeviceSignInContext = NoticeOccurrenceContext;

/**
 * `security/authentication.md` §3's unfamiliar-session notice.
 *
 * "Unfamiliar" is `LoginService`'s decision and is defined there, against what
 * the `Session` table can actually answer. Nothing in this file knows how that
 * question was asked.
 */
export function renderNewDeviceSignIn(context: NewDeviceSignInContext): RenderedEmail {
  return renderEmail({
    subject: 'New sign-in to your Sentinel account',
    paragraphs: [
      // No greeting by name. See `NewDeviceSignInContext` above.
      'Hello,',
      'Your Sentinel account was signed in to from a device we have not seen before.',
      ...whereAndWhen(context),
    ],
    footer: [...NOTICE_FOOTER],
  });
}

/**
 * THE NINTH TEMPLATE, AND THE FIRST THING THAT MAKES §7's LAST CLAUSE TRUE.
 *
 * `security/authentication.md` §7 has said "a burst notifies the account owner"
 * since Phase 0 and no template covered it: the five notices Task 5 built are
 * about changes to an account, and a burst of failed logins changes nothing.
 * Task 9 sends this on the attempt that trips the per-account lock — **once per
 * lock, not once per failure past the threshold**. The fifth message would tell
 * the recipient nothing the first did not, and a notice sent per failure is an
 * outbound-email amplifier aimed at the victim, triggered by an unauthenticated
 * caller at will.
 *
 * # It renders no name, no IP address and no user agent
 *
 * Rulings 63 and 70 together, and here they point the same way for once.
 *
 * - **No display name.** `User.name` is free text an attacker seeds by
 *   registering the victim's address first (F1). This notice reaches an account
 *   whose address may never have been confirmed, which is exactly the case the
 *   ruling is about.
 * - **No user agent.** It is a request header the guessing party chose
 *   outright — up to 512 characters of a sentence and a URL — and this message
 *   goes to somebody else. That is H1 verbatim.
 * - **No IP address.** Softer than the other two and still wrong: it is not the
 *   recipient's address, so it describes nothing they can check, and printing
 *   an arbitrary attacker's network location into a third party's mailbox
 *   invites exactly the "I looked it up and it's in ..." response that helps
 *   nobody. The IP is in the `PlatformAuditEvent` row, where an operator reads
 *   it.
 *
 * What is left is `{ occurredAt, attemptCount }`: our own clock reading and our
 * own counter. **Neither is caller-supplied**, so this template has no
 * parameter an attacker can reach at all — which is the property, rather than
 * an escaping claim about one.
 *
 * # It is a notice, so it carries no link
 *
 * `NOTICE_TEMPLATE_IDS`. The footer sends the recipient to the product the way
 * they normally reach it, and says no action is needed — which is true: nothing
 * about the account changed, and the lock is automatic and temporary. A notice
 * that induces action is a notice worth triggering on purpose, and triggering
 * this one costs an attacker five wrong passwords.
 */
export interface FailedLoginBurstContext {
  readonly occurredAt: Date;
  /**
   * `User.failedLoginCount` at the moment the lock tripped.
   *
   * A number this product computed, not a value from a request. It is rendered
   * because it is the one fact that separates "somebody mistyped" from
   * "somebody is guessing", and the recipient can act on the difference.
   */
  readonly attemptCount: number;
}

export function renderFailedLoginBurst(context: FailedLoginBurstContext): RenderedEmail {
  return renderEmail({
    subject: 'Repeated failed sign-in attempts on your Sentinel account',
    paragraphs: [
      // No name. See the docblock above.
      'Hello,',
      `There have been ${String(context.attemptCount)} failed sign-in attempts on your Sentinel account. To protect it, signing in has been blocked temporarily and will unblock itself.`,
      // The timestamp only. NOT `whereAndWhen`, which carries the IP and the
      // user agent of whoever was guessing — neither of which is the
      // recipient's, and one of which they chose.
      `When: ${formatUtcTimestamp(context.occurredAt)}`,
    ],
    footer: [
      // NOT `NOTICE_FOOTER`. Its first line tells the recipient to change their
      // password immediately, and nothing about this account changed: the
      // password was never accepted, which is why this message exists. The
      // advice below is the true version — and "no action is needed" is what
      // stops this being a message an attacker sends on purpose.
      'If this was you, no action is needed: wait a few minutes and try again, or use the "forgot password" option on the sign-in page.',
      'If it was not you, your password was not accepted and nothing about your account has changed. If you use this password anywhere else, change it there.',
      NOTICE_NEVER_ASKS,
    ],
  });
}
