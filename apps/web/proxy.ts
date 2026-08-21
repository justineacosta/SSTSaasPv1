import { NextResponse, type NextRequest } from 'next/server';
import { enforceCsp } from './src/env';
import { buildSecurityHeaders } from './src/security-headers';

/**
 * Every response from this origin passes through here and leaves with the
 * header table from `security/transport-and-headers.md` §2 and a per-request
 * CSP nonce (§3). It is the web origin's counterpart to the API's
 * `SecurityHeadersMiddleware`.
 *
 * **Why this file is `proxy.ts` and not `middleware.ts`.** The task brief
 * named `middleware.ts`. Next 16.3.2 renamed the convention: building with a
 * `middleware.ts` present prints
 *
 *   ⚠ The "middleware" file convention is deprecated. Please use "proxy"
 *     instead.
 *
 * — observed in this app's own build output before the rename, not inferred.
 * Next detects both files and errors if both exist. Two things follow from
 * the rename beyond the filename: the exported function must be named
 * `proxy`, and **proxy always runs on the Node.js runtime** (Next enforces
 * this — declaring a route-segment `runtime` in a proxy file is a build
 * error, message: "Proxy always runs on Node.js runtime").
 *
 * That second point is load-bearing here. On Node, `process.env` is an
 * ordinary fully-populated object, so `@sentinel/config`'s `loadEnv` works
 * exactly as it does in `apps/api`, with none of the build-time-inlining
 * caveats that would have applied to Edge middleware. Confirmed by observing
 * the flag it derives actually change: `APP_ENV=development` produced
 * `Content-Security-Policy-Report-Only` on a live response and
 * `APP_ENV=test` produced `Content-Security-Policy`, which is only possible
 * if `loadEnv` read the real environment from inside this file's bundle.
 */
export function proxy(request: NextRequest): NextResponse {
  // A nonce reused across responses is one an attacker can read from one page
  // and replay on the next, which is the same as having no nonce at all.
  // randomUUID() is CSPRNG-backed; base64 keeps it to the token grammar
  // `nonce-` expects.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const headers = buildSecurityHeaders(nonce, enforceCsp);

  const cspHeaderName = enforceCsp
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
  const policy = headers[cspHeaderName];

  // The nonce travels forward on the *request* so a server component can read
  // it for a `next/script` tag. Next itself reads the CSP request header to
  // find the nonce it stamps onto its own bootstrap scripts, which is why the
  // policy is forwarded too and not just `x-nonce`.
  //
  // Both CSP header names are cleared before one is set. Setting only the name
  // being sent would leave a client-supplied header under the *other* name
  // intact for Next to read a nonce out of — in report-only mode, an inbound
  // `Content-Security-Policy` request header would survive. Report-only is
  // development-only so there is nothing to bypass today, but "today" is not a
  // property worth depending on, and the fix is one line.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.delete('Content-Security-Policy');
  requestHeaders.delete('Content-Security-Policy-Report-Only');
  if (policy !== undefined) requestHeaders.set(cspHeaderName, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
