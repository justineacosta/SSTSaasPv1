/**
 * The web origin's response-header table (`security/transport-and-headers.md`
 * §2) and its nonce-based Content Security Policy (§3), as a pure function so
 * it can be asserted without booting Next.
 *
 * This is deliberately a near-copy of the API's
 * `apps/api/src/common/middleware/security-headers.middleware.ts` rather than a
 * shared package: the two origins serve different things and their policies
 * are allowed to diverge. Where they do diverge, the reason is written down
 * here and asserted in `security-headers.spec.ts`.
 *
 * Three deliberate divergences from the API's table:
 *
 * 1. **No blanket `Cache-Control: no-store`.** The API justifies its blanket
 *    `no-store` with "the API serves nothing cacheable; every response may
 *    contain tenant data". Neither half holds here, and §2 of
 *    transport-and-headers.md scopes `no-store` to *authenticated* responses
 *    rather than all of them. Every response leaves through this table,
 *    including the build's own assets, and those are measured to answer
 *    `Cache-Control: public, max-age=31536000, immutable` — a blanket
 *    `no-store` set here would throw that away and re-download the whole
 *    bundle on every navigation. Meanwhile Next already sends
 *    `private, no-cache, no-store, max-age=0, must-revalidate` on the HTML
 *    itself (measured on `/` and `/dashboard` against `next start`), so the
 *    responses that will one day carry tenant data are covered without this
 *    function touching the header at all.
 *
 * 2. **`report-uri` is `/api/csp-report`, on this origin**, not the API's
 *    `/api/v1/csp-report`. Two reasons, in order of weight. The API's
 *    collector does not exist — transport-and-headers.md §3 says so plainly,
 *    and a report sent there would 404. And the report is about *this*
 *    origin's policy, so keeping the collector same-origin means it does not
 *    depend on the API being reachable, on CORS, or on the API's rate limiter
 *    having an opinion about a browser-generated POST. The collector is
 *    `app/api/csp-report/route.ts`.
 *
 * 3. **No `Cross-Origin-Embedder-Policy: require-corp`.** §2 scopes COEP to
 *    "the app origin", and this Phase 1 shell has no cross-origin subresources
 *    to protect — but COEP blocks any third-party resource that does not opt
 *    in with CORP/CORS, which is a decision that belongs with the origin that
 *    actually embeds something (the evidence viewer, Phase 5). Enabling it now
 *    would be enforcing a rule against nothing and then discovering its cost
 *    later.
 *
 * On `'unsafe-eval'`: it is never emitted, in any environment. Next's dev-mode
 * HMR does need it, which is exactly why `operations/environments.md` §4 makes
 * the policy report-only in development — a violation report in a terminal is
 * a cheaper way to learn that than a policy with a permanent hole in it.
 *
 * On `upgrade-insecure-requests`: the one directive that is *not* identical in
 * both modes. The W3C Upgrade Insecure Requests specification — which defines
 * this directive; CSP Level 2 does not — says it is ignored when delivered in a
 * report-only policy, and Chromium says so out loud — `The Content Security
 * Policy directive 'upgrade-insecure-requests' is ignored when delivered in a
 * report-only policy` — on every single response. A permanent console error in
 * every local dev session is how a developer learns to ignore CSP console
 * errors, and it broke a Playwright run for a reason that was not a defect.
 * Omitting it while report-only costs no protection: it was never applied.
 * The API middleware makes the same call, and the specs on both sides assert
 * that the two policies differ by this directive and nothing else.
 */

/**
 * The header value sent with every response.
 *
 * @param enforceCsp Everything here is identical in both modes except
 *                   `upgrade-insecure-requests` — see the note above.
 */
function buildContentSecurityPolicy(nonce: string, enforceCsp: boolean): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' means scripts loaded *by* a nonced script inherit
    // trust, which is how Next's chunk loader works without an allowlist of
    // build-hashed filenames that changes on every deploy.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    // True rather than aspirational because next/font self-hosts IBM Plex at
    // build time — see app/fonts.ts.
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Ignored by spec in a report-only policy, and loudly so. See above.
    ...(enforceCsp ? ['upgrade-insecure-requests'] : []),
    'report-uri /api/csp-report',
  ].join('; ');
}

/**
 * @param nonce   Per-request nonce. Must be freshly generated per response — a
 *                nonce reused across responses is one an attacker can read
 *                from one page and reuse on the next.
 * @param enforceCsp `true` sends `Content-Security-Policy`; `false` sends
 *                `Content-Security-Policy-Report-Only` with the same policy
 *                text minus `upgrade-insecure-requests`, which a report-only
 *                policy is specified to ignore. Derived from `APP_ENV` in one
 *                place (`src/env.ts`) so it cannot drift per call site.
 */
export function buildSecurityHeaders(nonce: string, enforceCsp: boolean): Record<string, string> {
  const policy = buildContentSecurityPolicy(nonce, enforceCsp);

  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    [enforceCsp ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: policy,
  };
}
