import { ERROR_CODES } from '@sentinel/contracts';
import { ApiError } from './errors';

/**
 * Where a user goes when there is no intended destination to return to, and
 * what an unsafe one is replaced by.
 */
export const DEFAULT_POST_LOGIN_PATH = '/dashboard';

/** The query parameter carrying the intended destination on `/login`. */
export const REDIRECT_PARAM = 'next';

/**
 * Whitespace plus the C0 and C1 control ranges, built from a string of escapes
 * so that no literal control character ever sits in this file — one pasted into
 * a source line is invisible in a diff and in most editors.
 *
 * Browsers strip leading and trailing control characters and whitespace while
 * parsing a URL, so a value such as a newline followed by `//evil.example` is
 * navigated to as `//evil.example`. Refusing the whole class outright is
 * cheaper than reasoning about which of them each browser strips.
 */
/* eslint-disable-next-line no-control-regex -- matching control characters is the entire purpose of this pattern; the rule fires on them appearing by accident, which is the opposite of the case here. */
const UNSAFE_CHARACTERS = new RegExp('[\\s\\u0000-\\u001F\\u007F-\\u009F]');

/**
 * NOTHING ON THE AUTHENTICATION SCREENS IS A SECURITY CONTROL, WITH ONE
 * EXCEPTION, AND THIS IS IT.
 *
 * Every affordance on those screens is re-authorised server-side, so hiding a
 * button prevents nothing and this codebase should not pretend otherwise. This
 * function is the exception, because the redirect target is
 * **attacker-controlled input that the server never sees**. A link to
 * `https://sentinel.example/login?next=https://evil.example/login` that ends
 * with the browser on `evil.example` is an open redirect — a real finding, and
 * the one this exact feature is famous for. There is no second check behind
 * this one.
 *
 * The rule is deliberately a whitelist of one shape rather than a blacklist of
 * known-bad ones: **a same-origin path, and nothing else.**
 *
 * - must be a non-empty string starting with `/`;
 * - must not start with `//` — protocol-relative, and `//evil.example` is an
 *   absolute URL to another host in every browser;
 * - must contain no backslash — browsers normalise it to `/` while parsing, so
 *   a slash followed by a backslash is a protocol-relative URL too;
 * - must contain no whitespace or control characters (see above);
 * - and must still resolve to the same origin under the platform's own URL
 *   parser, which is the authority on what the browser will actually do.
 *
 * Anything else is replaced by the fallback rather than refused: the user asked
 * to sign in, and should end up signed in.
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_PATH,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.includes('\\')) return fallback;
  if (UNSAFE_CHARACTERS.test(raw)) return fallback;

  // A host that appears nowhere in this product, so that a value which somehow
  // smuggled an origin past the checks above cannot have smuggled in this one.
  const probeOrigin = 'https://redirect-probe.invalid';
  try {
    const resolved = new URL(raw, probeOrigin);
    if (resolved.origin !== probeOrigin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

/**
 * The `/login` URL that will return the user to where they were.
 *
 * `user-flows.md` §8: a session expiry returns to login and restores the
 * intended destination. The destination is validated on the way *in* as well as
 * on the way out — a caller passing an absolute URL here would otherwise write
 * an attacker's origin into a link the product renders itself.
 */
export function loginHrefForDestination(destination: string | null | undefined): string {
  const path = safeRedirectPath(destination, '');
  if (path === '') return '/login';
  return `/login?${REDIRECT_PARAM}=${encodeURIComponent(path)}`;
}

/**
 * Whether this failure means "sign in again", as opposed to any other 401.
 *
 * Both codes are 401s the frontend answers identically. They are separate codes
 * in `packages/contracts/src/error-codes.ts` because the API distinguishes
 * "your session ended" from "you never had one", and a later screen may want to
 * say something different about each.
 */
export function isSessionExpiry(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === ERROR_CODES.SESSION_EXPIRED || error.code === ERROR_CODES.UNAUTHENTICATED;
}
