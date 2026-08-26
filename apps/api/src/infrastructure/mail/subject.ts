/**
 * The subject is the one value in a message that leaves as an SMTP **header**,
 * and a header is terminated by CRLF.
 *
 * `Subject: Acme\r\nBcc: attacker@evil.test` adds a recipient the sender never
 * chose, and the interpolated half of a subject is attacker-chosen — an
 * organisation name in the invitation today, and whatever the next template
 * interpolates tomorrow. `escapeHtml` does not help, because a subject is never
 * markup.
 *
 * It lives here, in the mail infrastructure, rather than beside the email
 * layout, because **both** layers have to apply it. `renderEmail` sanitises
 * what a template produces; `SmtpMailer.send` sanitises what it is handed,
 * because `OutgoingMail` is a plain interface and a caller may assemble one
 * without going near a template (M2, Task 5 review). Running it twice is a
 * no-op, which is what makes duplicating it safe.
 *
 * nodemailer's own MIME encoder also refuses newlines in a header, which makes
 * this the *second* line of defence rather than the only one — deliberately, on
 * the same reasoning as the credential-pair check in `toTransportOptions`: a
 * control that exists only inside a dependency is a control that changes when
 * the dependency does. Every control character is collapsed to a space rather
 * than dropped, so an injected fragment cannot be silently rejoined into a
 * plausible subject.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

export function sanitizeSubject(subject: string): string {
  return subject.replace(CONTROL_CHARACTERS, ' ').trim();
}
