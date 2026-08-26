import { sanitizeSubject } from '../../../infrastructure/mail/subject.js';
import { escapeHtml } from './escape-html.js';

/**
 * The shared layout: the one place in this product that produces email markup.
 *
 * Templates below it assemble *content* — plain strings, a subject, some
 * paragraphs, at most one action — and never markup. That division is what
 * makes ruling 44's escaping claim answerable: every interpolated value in
 * every template passes through `escapeHtml` here, so the question "is
 * everything escaped" is about this file rather than about six.
 *
 * **Nothing here makes the recipient's client fetch anything.** Ruling 46: no
 * remote image, no external stylesheet, no web font, no tracking pixel. A
 * security product that opens a beacon in its own breach-notification emails is
 * making the argument against itself, and a remote image is the standard read
 * receipt besides. Inline CSS only, and `registry.spec.ts` asserts the absence
 * over every template rather than trusting this comment.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailAction {
  readonly label: string;
  readonly url: string;
}

export interface EmailContent {
  /**
   * Doubles as the heading and as the first line of the text part. One field
   * rather than two, so an `html` part and a `text` part cannot end up
   * disagreeing about what the message is called.
   */
  readonly subject: string;
  readonly paragraphs: readonly string[];
  /** Present on the three token-carrying templates; absent on the three notices. */
  readonly action?: EmailAction | undefined;
  readonly footer: readonly string[];
}

// Inline, because an email client will strip a <style> block and every one of
// them ignores an external sheet. Values, not a design system: packages/ui's
// tokens are CSS custom properties, which mail clients do not resolve.
const BODY_STYLE =
  'margin:0;padding:24px;background:#f4f5f7;' +
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
  'font-size:16px;line-height:1.5;color:#1a1d21;';
const CARD_STYLE =
  'max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;' +
  'border:1px solid #e3e5e8;padding:32px;';
const HEADING_STYLE = 'margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;';
const PARAGRAPH_STYLE = 'margin:0 0 16px;';
const BUTTON_STYLE =
  'display:inline-block;padding:12px 20px;border-radius:6px;background:#1a56db;' +
  'color:#ffffff;text-decoration:none;font-weight:600;';
const FALLBACK_STYLE = 'margin:16px 0 0;font-size:14px;color:#5b6169;word-break:break-all;';
const FOOTER_STYLE =
  'margin:24px auto 0;max-width:560px;font-size:13px;line-height:1.5;color:#5b6169;';

function paragraphsHtml(paragraphs: readonly string[]): string {
  return paragraphs
    .map((text) => `<p style="${PARAGRAPH_STYLE}">${escapeHtml(text)}</p>`)
    .join('\n      ');
}

/**
 * The action, rendered twice on purpose: as a button and again as the bare URL
 * beneath it. A client that suppresses styling, or a recipient who wants to see
 * where a link goes before following it, both need the second copy — and for a
 * password reset, "see where it goes first" is behaviour worth encouraging
 * rather than defeating.
 */
function actionHtml(action: EmailAction): string {
  const url = escapeHtml(action.url);
  return [
    `<p style="${PARAGRAPH_STYLE}"><a href="${url}" style="${BUTTON_STYLE}">${escapeHtml(action.label)}</a></p>`,
    `<p style="${FALLBACK_STYLE}">If the button does not work, copy this address into your browser:<br />${url}</p>`,
  ].join('\n      ');
}

function footerHtml(footer: readonly string[]): string {
  return footer
    .map((line) => `<p style="${PARAGRAPH_STYLE}">${escapeHtml(line)}</p>`)
    .join('\n    ');
}

function renderHtml(content: EmailContent): string {
  const blocks = [paragraphsHtml(content.paragraphs)];
  if (content.action !== undefined) blocks.push(actionHtml(content.action));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(content.subject)}</title>
  </head>
  <body style="${BODY_STYLE}">
    <div style="${CARD_STYLE}">
      <h1 style="${HEADING_STYLE}">${escapeHtml(content.subject)}</h1>
      ${blocks.join('\n      ')}
    </div>
    <div style="${FOOTER_STYLE}">
    ${footerHtml(content.footer)}
    </div>
  </body>
</html>
`;
}

/**
 * The text part is written from the same content, not derived from the markup.
 *
 * Stripping tags out of the HTML produces something that looks like prose and
 * is not: it inherits the layout's structure, loses the action label, and — in
 * the templates where it matters most — loses the link, which is the only
 * actionable thing in the message. Ruling 45 asserts the difference over every
 * template.
 */
function renderText(content: EmailContent): string {
  const blocks: string[] = [content.subject, '', content.paragraphs.join('\n\n')];
  if (content.action !== undefined)
    blocks.push('', `${content.action.label}: ${content.action.url}`);
  blocks.push('', '--', content.footer.join('\n'));
  return `${blocks.join('\n')}\n`;
}

export function renderEmail(content: EmailContent): RenderedEmail {
  const safe: EmailContent = { ...content, subject: sanitizeSubject(content.subject) };
  return {
    subject: safe.subject,
    html: renderHtml(safe),
    text: renderText(safe),
  };
}

/**
 * `[unit, seconds, smallest count worth expressing in it]`.
 *
 * Only `day` carries a minimum above one, and that is the interesting entry.
 * The email-verification TTL is exactly 86,400 seconds, which this table would
 * otherwise render as "1 day" — but `security/authentication.md` §6 states that
 * lifetime as **24h**, and "expires in 1 day" reads as a rounded approximation
 * of a deadline when it is an exact one. Two days and up are genuinely clearer
 * as days, so the exception stops at one.
 */
const SECONDS_IN = [
  ['day', 86_400, 2],
  ['hour', 3_600, 1],
  ['minute', 60, 1],
  ['second', 1, 1],
] as const;

/**
 * "24 hours", "1 hour", "7 days" — from the configured TTL, never written into
 * the prose.
 *
 * `security/authentication.md` §6 fixes the three lifetimes, but they live in
 * `packages/config` precisely so an operator can shorten one during an incident
 * without a deploy. A template that states "one hour" in its own text keeps
 * saying so after the reset TTL is cut to five minutes, and a message that
 * overstates a token's lifetime is a message that teaches users the product is
 * broken.
 *
 * The largest unit that divides exactly, so 90 minutes renders as "90 minutes"
 * rather than as "1 hour" — a stated lifetime must never exceed the real one.
 */
export function formatDuration(seconds: number): string {
  for (const [unit, size, minimumCount] of SECONDS_IN) {
    if (seconds % size !== 0) continue;
    const count = seconds / size;
    if (count < minimumCount) continue;
    return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
  }
  return `${String(seconds)} seconds`;
}

/**
 * `2026-08-26 09:41 UTC`. `api/conventions.md` §3 is UTC everywhere, and a
 * security notice is the worst place to omit a zone: the whole purpose of
 * "your password was changed at …" is to let the recipient decide whether it
 * was them, which they cannot do against an unqualified clock time.
 */
export function formatUtcTimestamp(when: Date): string {
  const [date, time] = when.toISOString().split('T');
  return `${date ?? ''} ${(time ?? '').slice(0, 5)} UTC`;
}
