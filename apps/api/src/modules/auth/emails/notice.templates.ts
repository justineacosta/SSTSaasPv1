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
 * **There is no `userAgent` field on any context in this file** — H2 removed
 * it, and the reasoning is under `NoticeOccurrenceContext` below. What remains
 * that a caller supplies is `ipAddress`, and it is not rendered as given: it is
 * held to an address shape by `renderableIpAddress`, so the line can carry an
 * address or the words "not recorded" and nothing else. It stays optional
 * because a caller must never invent one: "not recorded" is honest and a
 * fabricated address in a security notice is worse than an absent one.
 */

/**
 * The two lines `whereAndWhen` renders, split out from the greeting.
 *
 * It was split out from a wider `SecurityNoticeContext` because Task 9
 * introduced the first notice that renders the context block and **no** display
 * name (`newDeviceSignIn`): composing the block out of a narrower type is what
 * let that template drop `recipientName` without inventing a fake one to
 * satisfy this function's parameter.
 *
 * **As of Task 10 the wider type is gone and this one is the only context type
 * in the file** — ruling 70 closed to the class. The split survives it, because
 * `whereAndWhen` should keep taking the narrowest thing it needs rather than
 * whatever the notices happen to accept this year.
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

/**
 * `SecurityNoticeContext` USED TO LIVE HERE AND CARRIED A `recipientName`. IT
 * IS GONE, AND ITS ABSENCE IS RULING 70 CLOSED.
 *
 * Every notice now takes `NoticeOccurrenceContext` and nothing else, so there
 * is **no context type in this file with a display-name field**. `User.name` is
 * free text an attacker seeds by registering a victim's address first, and the
 * ruling's rule — a message sent to an address whose ownership has not been
 * proven must render no stored display name — has produced findings through
 * three separate channels now (Task 8's H1 and F1, Task 9's H2).
 *
 * Closed to the CLASS rather than to the instance with a caller, which is
 * ruling 71's habit. `passwordChanged` gets its caller in Task 10;
 * `mfaEnabled` and `mfaDisabled` do not get one until Task 11 and lost the
 * field anyway. Task 9 is the case study for why: `newDeviceSignIn` was "safe
 * because it has no caller yet" right up to the commit that gave it one, in the
 * same task, and the sentence recording that safety was left behind.
 *
 * What a caller may still supply is an IP address, and it is not rendered as
 * given — `renderableIpAddress` holds it to an address shape (ruling 72:
 * enforce the claim where the value is rendered, not where you believe it came
 * from).
 */

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
/**
 * A dotted quad of decimal digits, and nothing that merely resembles one.
 *
 * Deliberately not a validity check: `999.999.999.999` passes here and is not
 * an address. This guard's job is to bound what the line can *say*, not to
 * parse — `request.ip` is Express's socket peer address and is already a real
 * one. A range check would be a second, weaker implementation of a question
 * Postgres and Node have already answered.
 */
const IPV4_SHAPED = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/;

/**
 * Anything containing a colon, over the hex-address alphabet. The colon is the
 * discriminator: a DNS label cannot contain one, so no hostname reaches this
 * arm, and every IPv6 spelling — including the IPv4-mapped
 * `::ffff:192.0.2.128` — does.
 */
const IPV6_SHAPED = /^(?=.*:)[0-9a-fA-F:.]{3,45}$/;

/**
 * WHY THE CHARACTER CLASS ALONE WAS NOT ENOUGH. N-4.
 *
 * The first version of this guard was `^[0-9a-fA-F.:]{3,45}$`, chosen to make
 * it "impossible for this line to carry a sentence, a URL, or markup". It
 * achieves the sentence and the markup. It did not achieve the URL: that class
 * admits any string of hex letters and dots, and `facade.de`, `abcdef.cc` and
 * `dead.beef.cafe` are all hostnames under real top-level domains, which many
 * mail clients autolink from a bare domain with no scheme. The suite did not
 * see it because its assertion is `https?://`, and a bare hostname has neither.
 *
 * Not reachable today — `trust proxy` is disabled, so this value is the socket
 * peer address and never a client-chosen header (`request-context.ts`,
 * `security/abuse-prevention.md` §1). It is narrowed anyway, because the day it
 * becomes reachable is the day somebody is thinking about forwarded headers and
 * not about a regular expression in an email template.
 *
 * H2's lesson, one layer down: the claim "this value cannot carry a URL" was
 * asserted about the *source* and enforced against a *shape*, and the two were
 * not the same set.
 */
function renderableIpAddress(value: string | undefined): string {
  if (value === undefined) return UNKNOWN;
  return IPV4_SHAPED.test(value) || IPV6_SHAPED.test(value) ? value : UNKNOWN;
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

/**
 * `security/authentication.md` §2's "password change and reset revoke all other
 * sessions and email the user", and Task 10 is where it gets its caller.
 *
 * **One template for both endpoints, and the copy has to be true of both.** A
 * change signs out every *other* session and rotates the caller's own; a reset
 * signs out every session there is, and the person completing it was holding
 * none. "Any other sessions were signed out" is the sentence that is true on
 * both paths — the earlier "Every other session was signed out" was written
 * before either caller existed and is false of a reset, which signs out the
 * one the sentence excludes.
 *
 * It renders **no display name** (see the block above `UNKNOWN`) and an IP
 * address only when the value is an address literal. The IP is worth keeping
 * here even though a reset may have been completed by an attacker: it is the
 * one line the recipient can check against where they actually were, and
 * `renderableIpAddress` is what stops it saying anything else.
 */
export function renderPasswordChanged(context: NoticeOccurrenceContext): RenderedEmail {
  return renderEmail({
    subject: 'Your Sentinel password was changed',
    paragraphs: [
      // No greeting by name. Ruling 70, closed.
      'Hello,',
      'The password on your Sentinel account was changed. Any other sessions were signed out.',
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
export type MfaChange = 'enabled' | 'disabled' | 'recoveryCodesRegenerated';

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
  // REVIEW M4. The eighth template, and the reason it exists is that
  // regeneration was the ONLY MFA state change that told the owner nothing.
  // Enabling, disabling and a challenge from a new device all send mail;
  // regenerating silently destroys the credential the owner is holding on
  // paper, which is precisely why an attacker with a stolen session and the
  // password would choose it. The implementer deferred this on ruling 43 — that
  // adding a template is a registry change nobody owns — and ruling 43 is the
  // argument FOR closing it here rather than against: a gap owned by no task is
  // a gap that never closes.
  recoveryCodesRegenerated: {
    subject: 'New recovery codes were generated for your Sentinel account',
    body: [
      'A new set of recovery codes was generated for your Sentinel account. The codes you had before no longer work.',
      'If you did not do this, your password may be known to someone else. Change it now and regenerate your recovery codes again.',
    ],
  },
};

export interface MfaChangedInput extends NoticeOccurrenceContext {
  readonly change: MfaChange;
}

/**
 * **No display name, although Task 11 owns the callers and Task 10 shipped
 * this.** Ruling 70 closed to the class rather than to the instance: leaving
 * the field on a template with no caller is how `newDeviceSignIn` arrived at
 * Task 9 carrying an injection with a written-down reason for why it was fine.
 */
export function renderMfaChanged(input: MfaChangedInput): RenderedEmail {
  const copy = MFA_COPY[input.change];
  return renderEmail({
    subject: copy.subject,
    paragraphs: ['Hello,', ...copy.body, ...whereAndWhen(input)],
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
export function renderMfaEnabled(context: NoticeOccurrenceContext): RenderedEmail {
  return renderMfaChanged({ ...context, change: 'enabled' });
}

export function renderMfaDisabled(context: NoticeOccurrenceContext): RenderedEmail {
  return renderMfaChanged({ ...context, change: 'disabled' });
}

export function renderMfaRecoveryCodesRegenerated(context: NoticeOccurrenceContext): RenderedEmail {
  return renderMfaChanged({ ...context, change: 'recoveryCodesRegenerated' });
}

/**
 * What `registrationAttempt` may be told, and it is deliberately narrower than
 * `NoticeOccurrenceContext` — the timestamp alone, with no IP.
 *
 * H1, and the finding that started the chain H2 ended. `whereAndWhen` rendered
 * `Device: <userAgent>` at the time — it renders no device line at all now, on
 * any template — and on this one the user agent belonged to **a stranger**:
 * `POST /auth/register` against an address
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
      // four notices' block and carries the caller's IP. See
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
 * **The IP stays and the user agent does not.** H2: this notice fires on an
 * *unfamiliar* sign-in, so on the takeover path the device string is the
 * attacker's sentence delivered to the victim under this product's branding —
 * the recipient and the chooser are different people in exactly the case the
 * message exists for. That is the condition ruling 63's own sentence forbids,
 * which is why the carve-out it granted is withdrawn rather than narrowed. The
 * IP survives because `renderableIpAddress` holds it to an address shape, so it
 * is the one field here that cannot be made to say anything.
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
