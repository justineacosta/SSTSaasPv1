/**
 * The three links that carry a live credential, and the only way to build one.
 *
 * **This file has no imports and can never acquire one that matters.** Ruling
 * 42: a password-reset link built from an incoming HTTP request is a
 * well-known account-takeover primitive — the attacker submits the victim's
 * address with a forged `Host`, the application builds the link from the
 * request it happens to have in scope, and the victim receives a genuine
 * message from a genuine sender whose link hands the token to the attacker. No
 * filter catches it, because nothing about the message is fake.
 *
 * The defence is structural rather than a rule to remember. `buildTokenLink`
 * takes three primitives and has no parameter an HTTP request could arrive
 * through, and `links.spec.ts` asserts both the arity and — against the source
 * text — that nothing in this file names a request, a header or an incoming
 * host. A signature is load-bearing only until someone widens it.
 *
 * **The secret travels as `?token=`, never as a path segment.** Ruling 41,
 * standing on carry-forward rulings 34 and 36: Task 4 measured the redacting
 * logger against four shapes carrying a real 256-bit token, and only a query
 * parameter named `token` was redacted. `key` and `code` were deliberately
 * removed from that pattern's name list because `redact()` blanks the whole
 * field on a match and both names collide with this product's object-storage
 * URLs and its SCREAMING_SNAKE error codes. A token in a path segment
 * (`/verify/<token>`) is covered by nothing and was measured leaking verbatim.
 */

/**
 * The closed set of destinations. The path is chosen from here rather than
 * passed in, because a caller that could pass a path could pass `//evil.test`,
 * and resolving that against a base yields a different site entirely.
 *
 * These paths are the contract with the Task 16 screens that will read the
 * token. Changing one after a message is in somebody's inbox breaks a link that
 * has already been sent, which is why the format was settled before the first
 * send rather than after.
 */
export const TOKEN_LINK_PATHS = {
  emailVerification: '/verify-email',
  passwordReset: '/reset-password',
  invitation: '/accept-invitation',
} as const;

export type TokenLinkKind = keyof typeof TOKEN_LINK_PATHS;

/**
 * Builds an absolute link from the configured web base URL and nothing else.
 *
 * `webBaseUrl` is `WEB_BASE_URL` from `packages/config`, threaded in by the
 * caller. The base's scheme, authority and any path prefix are preserved; any
 * query string or fragment already on it is discarded, so a base carrying
 * `?next=` cannot smuggle a second parameter into the page that reads the
 * token. The token is set through `searchParams`, which percent-encodes rather
 * than reinterprets — so no value of `token` can add a parameter, change the
 * path, or reach another site.
 */
export function buildTokenLink(webBaseUrl: string, kind: TokenLinkKind, token: string): string {
  const link = new URL(webBaseUrl);
  link.search = '';
  link.hash = '';
  link.pathname = `${link.pathname.replace(/\/+$/, '')}${TOKEN_LINK_PATHS[kind]}`;
  link.searchParams.set('token', token);
  return link.toString();
}
