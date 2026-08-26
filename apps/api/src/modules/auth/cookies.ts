/**
 * THE SESSION COOKIE'S NAME AND ATTRIBUTES, IN ONE PLACE, AS PURE FUNCTIONS.
 *
 * `security/authentication.md` §3 gives the cookie exactly: `HttpOnly`,
 * `Secure`, `SameSite=Lax`, the `__Host-` prefix, path `/`. Every one of those
 * is a control, and a control written out at each call site is a control that
 * drifts — the login response, the rotation response and the logout response
 * are three different handlers in Task 7 and Task 9, and two of them agreeing
 * is not the same as all three being right.
 *
 * **No `Request`, no `Response`, no framework.** These functions take strings
 * and return a string, which is what lets the attributes be asserted directly
 * in `cookies.spec.ts` rather than through an HTTP round trip. Task 7 attaches
 * the result with `res.setHeader('Set-Cookie', …)`; nothing here knows that.
 *
 * **Reading a cookie off a request is deliberately not here.** Task 6 issues
 * credentials and never inspects one, and the parsing side belongs with the
 * guard that needs it (Task 7). A parser sitting here unused would be a surface
 * for a caller to authenticate against before a guard exists to say what
 * authentication means.
 *
 * **`__Host-` over `http://localhost` was measured, not assumed.** A `__Host-`
 * cookie must carry `Secure`, and `Secure` is honoured only on a trustworthy
 * origin. Probed on 2026-08-26 against Chromium 151.0.7922.34 driven by
 * Playwright: a throwaway `http://localhost` server emitted this exact header
 * and the cookie was stored (`domain: "localhost"`, `path: "/"`,
 * `httpOnly: true`, `secure: true`, `sameSite: "Lax"`) and sent back on the
 * next request. The two negative controls in the same run — the same cookie
 * with `Domain=localhost`, and with `Path=/sub` — were both rejected, which is
 * what rules out "the browser ignores the prefix entirely". The raw output is
 * in this task's report. This matters because Task 18's end-to-end suite runs
 * against `http://localhost`, and a rejected cookie there looks exactly like an
 * application bug.
 */

/** §3. The prefix is part of the name; a browser enforces the rest from it. */
export const SESSION_COOKIE_NAME = '__Host-session';

/**
 * The attributes every cookie this module emits carries, in one array.
 *
 * `Path=/` and the absence of `Domain` are not stylistic: `__Host-` *requires*
 * both, and a browser silently drops a `__Host-` cookie that breaks either
 * rule. Silently is the problem — there is no error, the cookie simply never
 * arrives, so the failure surfaces as "the user is not logged in" one layer
 * away from its cause.
 *
 * The clearing header repeats this list rather than shortening it, because a
 * browser matches a replacement cookie on name, domain and path together.
 */
const SHARED_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'] as const;

/**
 * RFC 6265 §4.1.1's `cookie-octet`: US-ASCII excluding control characters,
 * whitespace, double quote, comma, semicolon and backslash.
 *
 * The token this cookie carries is base64url (`secret-token.ts`), which cannot
 * contain any of them, so this guard never fires on the intended input. It is
 * here for the input that is not intended: a value containing CR or LF would
 * end the header and let the rest be chosen by whoever supplied it. Carry-
 * forward ruling 42 is the same lesson one layer up — the mail recipient guard
 * that half-held was still what made the defect findable, and a guard that
 * cannot fire on today's input is not the same as a guard that is not needed.
 */
const COOKIE_VALUE = /^[!#-+\--:<-[\]-~]+$/;

export interface SessionCookieInput {
  /** The raw session token. Never logged; this is the only place it is framed. */
  readonly value: string;
  /**
   * `null` emits **no** `Max-Age` and **no** `Expires`, which makes it a
   * browser-session cookie: it is discarded when the browser closes.
   *
   * That is the honest rendering of §3's "remember me". Without it the user
   * chose a session that ends with the browser; with it they chose one that
   * survives a restart, and the number they get is the absolute lifetime the
   * server is already enforcing. **The cookie is never the authority on
   * lifetime** — `Session.absoluteExpiresAt` and `Session.idleExpiresAt` are,
   * and both are re-checked on every resolve. A client that keeps the cookie
   * past `Max-Age`, or discards it early, changes nothing about what the token
   * is worth.
   */
  readonly maxAgeSeconds: number | null;
}

function assertCookieValue(value: string): void {
  if (!COOKIE_VALUE.test(value)) {
    throw new Error('Refusing to serialise a cookie value outside RFC 6265 cookie-octet.');
  }
}

/**
 * `Max-Age` is `delta-seconds` (RFC 6265 §5.2.2) — digits only.
 *
 * A decimal makes a browser ignore the whole attribute, turning a persistent
 * cookie into a browser-session one; a negative value tells it to delete the
 * cookie at once. Both are quiet failures, so the arithmetic is clamped and
 * floored here rather than trusted from a caller's subtraction of two clocks.
 */
function deltaSeconds(maxAgeSeconds: number): string {
  return String(Math.max(0, Math.floor(maxAgeSeconds)));
}

/** `Set-Cookie` for a freshly issued or freshly rotated session. */
export function serialiseSessionCookie(input: SessionCookieInput): string {
  assertCookieValue(input.value);

  const attributes: string[] = [...SHARED_ATTRIBUTES];
  if (input.maxAgeSeconds !== null) {
    attributes.push(`Max-Age=${deltaSeconds(input.maxAgeSeconds)}`);
  }

  return [`${SESSION_COOKIE_NAME}=${input.value}`, ...attributes].join('; ');
}

/**
 * `Set-Cookie` that removes the session cookie — logout, and any refusal that
 * has decided the credential in the browser is worthless.
 *
 * Emitting this is never sufficient on its own: a cookie is only a copy of a
 * token the server already knows, so clearing it without revoking the row would
 * leave a live credential in whatever else holds it. The revocation is
 * `SessionService.revoke`'s; this is the browser's half.
 */
export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE_NAME}=`, ...SHARED_ATTRIBUTES, 'Max-Age=0'].join('; ');
}
