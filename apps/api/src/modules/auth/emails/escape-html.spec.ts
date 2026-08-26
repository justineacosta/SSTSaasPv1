import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escape-html.js';

/**
 * THE ESCAPE IS THE SECURITY CONTROL, SO IT IS TESTED AS ONE.
 *
 * Ruling 44 chose plain TypeScript functions over a template engine precisely
 * so that escaping is an explicit call at every interpolation rather than a
 * property of a library that nobody re-checks. That trade only pays if the
 * escape itself is right, which is what this file is for.
 *
 * A display name is attacker-controlled — a registering user chooses it — and
 * three of the six templates address the recipient by it. An unescaped one is
 * stored XSS in whatever webmail client renders the message.
 */
describe('escapeHtml', () => {
  it('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('leaves the forward slash alone, deliberately', () => {
    // OWASP's aggressive set also encodes `/`, on the "closing tag" argument.
    // It buys nothing once `<` and `>` are both escaped — no tag can form to be
    // closed — and it costs something real: the one place a URL reaches an
    // `html` part is an `href`, and `https:&#x2F;&#x2F;…` there is unreadable in
    // source and unparseable by a test that wants to assert on a real URL.
    // Readability of the thing under test is worth more than a redundant
    // escape, and this pins the choice so it is not silently reversed.
    expect(escapeHtml('https://example.test/a')).toBe('https://example.test/a');
  });

  it('escapes the double quote, which is what breaks out of an attribute', () => {
    expect(escapeHtml('" onmouseover="steal()')).toContain('&quot;');
    expect(escapeHtml('" onmouseover="steal()')).not.toContain('"');
  });

  it('escapes the single quote too, for single-quoted attribute contexts', () => {
    expect(escapeHtml("' onload='x")).not.toContain("'");
  });

  it('escapes the ampersand first, so an escape cannot be undone by a later one', () => {
    // Replacing < before & would turn "&lt;" typed by a user into "&amp;lt;"
    // only if & ran second — and would turn a genuine "<" into "&lt;" that the
    // ampersand pass then double-escapes. Either ordering bug shows up here.
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('escapes the backtick, which older attribute parsers accept as a delimiter', () => {
    expect(escapeHtml('`x`')).not.toContain('`');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('leaves non-ASCII alone rather than mangling a name', () => {
    // A name is not a security boundary in itself; entity-encoding every
    // non-ASCII character would make legitimate names unreadable for no gain.
    expect(escapeHtml('Zoë Müller 田中')).toBe('Zoë Müller 田中');
  });

  it('handles the empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes every occurrence, not only the first', () => {
    expect(escapeHtml('<<<')).toBe('&lt;&lt;&lt;');
  });
});
