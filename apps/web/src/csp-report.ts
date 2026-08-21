import { z } from 'zod';

/**
 * Everything the `/api/csp-report` collector does to a request body, with no
 * Next and no I/O, so it can be asserted directly.
 *
 * The route handler around this is deliberately thin: bound the body, hand the
 * text here, log what comes back. That split exists because the handler
 * answers 204 to every input — a deliberate choice, since a violation report's
 * response is discarded by the browser and a status code is free
 * reconnaissance — which makes an HTTP-level test unable to tell a working
 * collector from a deleted one.
 */

/**
 * Maximum accepted body. A real `report-uri` payload is a few hundred bytes;
 * the largest field this schema keeps is `original-policy` at 4 KB, so 8 KB is
 * roughly twice the largest legitimate report.
 *
 * This endpoint is unauthenticated, is behind no rate limiter (the API's
 * limiter runs on the other origin), and its URL is published to every browser
 * in the world inside the CSP header. Next's App Router applies no default
 * body-size limit — `api.bodyParser.sizeLimit` was Pages Router only — so
 * without this cap `await request.text()` buffers whatever it is sent.
 */
export const CSP_REPORT_MAX_BYTES = 8 * 1024;

/**
 * The `report-uri` wire format: a single `csp-report` object with hyphenated
 * keys. Every field is optional because the set a browser actually sends
 * varies by browser and by violation, and a schema that rejects a report is a
 * schema that loses the signal it exists to collect.
 *
 * Unknown keys are stripped rather than passed through, so a field a future
 * browser adds cannot put unreviewed content into the log.
 */
const cspReportSchema = z.object({
  'csp-report': z
    .object({
      'document-uri': z.string().max(2048).optional(),
      referrer: z.string().max(2048).optional(),
      'violated-directive': z.string().max(256).optional(),
      'effective-directive': z.string().max(256).optional(),
      'original-policy': z.string().max(4096).optional(),
      disposition: z.string().max(32).optional(),
      'blocked-uri': z.string().max(2048).optional(),
      'status-code': z.number().int().optional(),
      'script-sample': z.string().max(256).optional(),
      'line-number': z.number().int().optional(),
      'column-number': z.number().int().optional(),
      'source-file': z.string().max(2048).optional(),
    })
    .strip(),
});

export type CspReport = z.infer<typeof cspReportSchema>['csp-report'];

/** Replaces a path segment that cannot be proven to be a route name. */
const OPAQUE_SEGMENT = ':seg';

/**
 * True when a path segment is safe to log as-is.
 *
 * The threat is concrete rather than theoretical. `ui-ux/page-map.md` commits
 * `(auth)` to `/invitations/[token]`, `/reset-password` and `/verify-email`;
 * browsers strip the fragment from `document-uri` but keep the path and the
 * query, so from Phase 2 onward an ordinary CSP violation on an invitation
 * page would otherwise write a live invitation token into the log. That is
 * CLAUDE.md security rule 6.
 *
 * The rule: a real route name in this product is a short lowercase word or
 * hyphenated pair — `invitations`, `reset-password`, `organizations`,
 * `audit-logs`, the longest in the whole page map being 13 characters.
 * Anything else is treated as an identifier. Long-and-contains-digits is
 * rejected outright, which covers UUIDs, this repo's prefixed UUIDv7 ids, and
 * base64url tokens.
 *
 * **What this does not guarantee.** It is a shape heuristic, not a route
 * table. A token that happens to be short, lowercase and digit-free would
 * survive it. The correct fix is to match the real route manifest and log the
 * pattern, and that is owed by whichever phase ships token-bearing URLs —
 * this is a floor, not a solution.
 */
function segmentIsRouteName(segment: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(segment)) return false;
  if (segment.length > 24) return false;
  if (segment.length >= 12 && /\d/.test(segment)) return false;
  return true;
}

/**
 * Reduces a URL reported by the browser to something safe to write down:
 * origin plus a path whose identifier-shaped segments are masked, with the
 * query string and fragment dropped entirely.
 */
export function sanitizeReportedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // `document-uri` is always an absolute URL in practice. Anything that is
    // not parseable is unexpected input, and unexpected input is exactly what
    // should not be echoed into a log verbatim.
    return '[unparsable]';
  }

  const path = url.pathname
    .split('/')
    .map((segment) => (segment === '' || segmentIsRouteName(segment) ? segment : OPAQUE_SEGMENT))
    .join('/');

  return `${url.origin}${path}`;
}

/**
 * Reads at most `CSP_REPORT_MAX_BYTES`, refusing before anything is buffered
 * where possible.
 *
 * `Content-Length` is checked first because it lets an oversized request be
 * rejected without reading a byte — but it is client-supplied, so it is a
 * fast path and not the control. The control is the running total below,
 * which abandons the stream the moment the budget is exceeded regardless of
 * what the header claimed.
 */
export async function readBoundedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) return null;

  const body = request.body;
  if (body === null) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CSP_REPORT_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

export type CspReportParseResult =
  | { readonly ok: true; readonly report: CspReport }
  | { readonly ok: false; readonly reason: 'malformed-json' | 'schema' };

/**
 * Parses, validates, strips unknown keys, and masks the two URL-bearing
 * fields. Never throws: a collector that throws on hostile input is a
 * collector that turns a violation report into an error report.
 */
export function parseCspReport(body: string): CspReportParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }

  const parsed = cspReportSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: 'schema' };

  const report = { ...parsed.data['csp-report'] };
  if (report['document-uri'] !== undefined) {
    report['document-uri'] = sanitizeReportedUrl(report['document-uri']);
  }
  if (report.referrer !== undefined && report.referrer !== '') {
    report.referrer = sanitizeReportedUrl(report.referrer);
  }

  return { ok: true, report };
}
