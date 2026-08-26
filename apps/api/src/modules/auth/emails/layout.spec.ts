import { describe, expect, it } from 'vitest';
import { formatDuration, formatUtcTimestamp, renderEmail } from './layout.js';

/**
 * The layout is the only thing in this directory that produces HTML.
 *
 * That is deliberate and it is what makes ruling 44's escaping claim checkable:
 * every interpolated value passes through one function, so "is every value
 * escaped" is a question about one file rather than about six. Templates
 * assemble *content* — raw strings — and never markup.
 */
describe('renderEmail', () => {
  const content = {
    subject: 'Confirm your email address',
    paragraphs: ['Hello Ada.', 'Please confirm the address you registered with.'],
    action: { label: 'Confirm email', url: 'https://app.sentinel.test/verify-email?token=abc' },
    footer: ['You are receiving this because someone registered with this address.'],
  } as const;

  it('returns all three parts, none of them empty', () => {
    const email = renderEmail(content);
    expect(email.subject).toBe('Confirm your email address');
    // The subject doubles as the heading: one field, so an html part and a
    // text part cannot disagree about what the message is called, and so a
    // client showing a preview line shows the same sentence twice rather than
    // two different ones.
    expect(email.text.split('\n')[0]).toBe('Confirm your email address');
    expect(email.html.length).toBeGreaterThan(0);
    expect(email.text.length).toBeGreaterThan(0);
  });

  it('escapes the content it is given rather than trusting the caller', () => {
    const email = renderEmail({
      ...content,
      paragraphs: ['Hello <script>alert(1)</script>.'],
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('escapes the action URL for the attribute it lands in', () => {
    const email = renderEmail({
      ...content,
      action: { label: 'Go', url: 'https://app.test/x?a=1&b="2' },
    });
    expect(email.html).toContain('&amp;');
    // The `"` must not survive into the href, or the attribute ends early and
    // everything after it is parsed as markup.
    expect(email.html).not.toContain('href="https://app.test/x?a=1&b="2"');
  });

  it('puts the action URL in the text part in full, since text has no links', () => {
    const email = renderEmail(content);
    expect(email.text).toContain('https://app.sentinel.test/verify-email?token=abc');
  });

  it('produces a text part that is not the HTML part with its tags removed', () => {
    // Ruling 45's rule, at the layer that decides it. A text part derived by
    // stripping tags inherits the layout's structure and loses the link, which
    // is the only actionable thing in half these messages.
    const email = renderEmail(content);
    expect(email.text).not.toContain('<');
    expect(email.text).not.toContain('style=');
    expect(email.text).toContain('Hello Ada.');
  });

  it('omits the action block entirely when there is none', () => {
    const email = renderEmail({
      subject: 'Your password was changed',
      paragraphs: ['This is a notice.'],
      footer: ['Sentinel security notice.'],
    });
    expect(email.html).not.toContain('href');
    expect(email.text).not.toContain('http');
  });

  it('fetches nothing from the network when the message is opened', () => {
    // Ruling 46. A remote image in a security product's own security notices is
    // both a read receipt and an argument against the product. There is no
    // stylesheet, no font, no logo and no beacon — inline CSS only.
    const { html } = renderEmail(content);
    for (const forbidden of ['<img', 'src=', '<link', '@import', 'url(', 'background=']) {
      expect(html).not.toContain(forbidden);
    }
    // The only absolute URL anywhere in the markup is the action's, and it
    // reaches the network only if the recipient chooses to follow it. Deduped
    // rather than counted: the action deliberately appears twice, once as the
    // button and once as the bare address beneath it.
    const urls = new Set(html.match(/https?:\/\/[^\s"'<>]+/g) ?? []);
    expect([...urls]).toEqual(['https://app.sentinel.test/verify-email?token=abc']);
  });

  it('declares a character set so a non-ASCII display name is not mojibake', () => {
    expect(renderEmail(content).html).toContain('charset="utf-8"');
  });

  it('strips CRLF out of the subject, which is where header injection lands', () => {
    // The subject is the one rendered value that leaves as an SMTP header, and
    // a header is terminated by CRLF. An organisation name reaches the
    // invitation subject, so `Acme\r\nBcc: attacker@evil.test` would otherwise
    // be an added recipient the sender never chose. `escapeHtml` is no help
    // here — a subject is never markup.
    const email = renderEmail({
      ...content,
      subject: 'Acme\r\nBcc: attacker@evil.test',
    });
    expect(email.subject).toBe('Acme Bcc: attacker@evil.test');
    expect(email.subject).not.toContain('\r');
    expect(email.subject).not.toContain('\n');
  });

  it('collapses any control character in the subject, not only CR and LF', () => {
    // A bare LF is enough on some relays, and a NUL can truncate a header in a
    // C parser downstream. Matching the whole control range costs nothing.
    expect(renderEmail({ ...content, subject: 'a\u0000b\u000bc\u007fd' }).subject).toBe('a b c d');
  });

  it('keeps the sanitised subject as the first line of the text part', () => {
    // Otherwise the header and the body would disagree about the name of the
    // message, which is exactly what an injection attempt wants.
    const email = renderEmail({ ...content, subject: 'Acme\r\nBcc: x@evil.test' });
    expect(email.text.split('\n')[0]).toBe(email.subject);
  });
});

describe('formatDuration', () => {
  // The TTLs are configuration (packages/config), so the sentence a user reads
  // has to be derived from the configured value rather than written by hand —
  // otherwise shortening the reset TTL during an incident leaves every mail
  // claiming an hour.
  it.each([
    [86_400, '24 hours'],
    [3_600, '1 hour'],
    [604_800, '7 days'],
    [172_800, '2 days'],
    [1_800, '30 minutes'],
    [60, '1 minute'],
    [45, '45 seconds'],
    [1, '1 second'],
  ])('renders %i seconds as "%s"', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it('falls back to the largest whole unit rather than inventing a fraction', () => {
    // 90 minutes is not "1 hour" and not "1.5 hours"; a token's stated lifetime
    // must never be longer than its real one.
    expect(formatDuration(5_400)).toBe('90 minutes');
  });
});

describe('formatUtcTimestamp', () => {
  it('renders UTC, and says so', () => {
    // api/conventions.md §3: always UTC. A notice that says "your password was
    // changed at 09:41" without a zone is a notice the recipient cannot use to
    // decide whether it was them.
    expect(formatUtcTimestamp(new Date('2026-08-26T09:41:07.512Z'))).toBe('2026-08-26 09:41 UTC');
  });

  it('does not drift with the machine local time zone', () => {
    expect(formatUtcTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 5)))).toBe('2026-01-01 00:05 UTC');
  });
});
