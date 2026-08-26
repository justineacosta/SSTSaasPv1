/**
 * HTML escaping for the mail path.
 *
 * This exists as its own file, with its own spec, because it is the security
 * control that ruling 44 chose plain functions over a template engine to keep
 * visible. An engine's auto-escaping is a property you assume and then stop
 * testing; a function is a call you can see, and a missing call is a diff.
 *
 * **Every value interpolated into an `html` part goes through here, including
 * the ones that look safe.** A display name is chosen by whoever registers, an
 * organisation name by whoever creates it, and a user agent is a request header
 * — all three reach these templates. An unescaped one is stored XSS in whatever
 * webmail client renders the message, delivered by us, from our domain, past
 * every filter that trusts us.
 *
 * In practice `layout.ts` is the only caller: it is the one place that produces
 * markup, so "is every value escaped" is a question about one file.
 */

/**
 * `&` is first in the list and that ordering is not cosmetic — replacing it
 * after `<` would re-escape the `&` this table's own output introduces, turning
 * `<` into `&amp;lt;` and showing the entity to the reader.
 *
 * `/` is deliberately absent. OWASP's aggressive set includes it on a
 * "premature closing tag" argument that cannot apply once `<` and `>` are both
 * escaped, and encoding it would render the one URL in an `html` part as
 * `https:&#x2F;&#x2F;…` — unreadable in source and unparseable by a test that
 * wants to assert against a real URL. The backtick is present because some
 * older attribute parsers accept it as a quote character.
 */
const HTML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#39;'],
  [/`/g, '&#96;'],
];

/**
 * Escapes text for either an element body or a double- or single-quoted
 * attribute value. Non-ASCII is left alone: a name is not a security boundary,
 * and entity-encoding every accented character would make legitimate names
 * unreadable for no gain.
 */
export function escapeHtml(value: string): string {
  let escaped = value;
  for (const [pattern, replacement] of HTML_ESCAPES) {
    escaped = escaped.replace(pattern, replacement);
  }
  return escaped;
}
