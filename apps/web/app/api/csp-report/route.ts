import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '../../../src/logger';

/**
 * The collector named by `report-uri` in this origin's CSP
 * (`src/security-headers.ts`).
 *
 * Wired from day one, and the reports actually get read: a CSP nobody
 * monitors is decoration (security/transport-and-headers.md §3). It is also
 * the only signal that will tell us the policy is about to break something
 * when development flips from report-only to enforcing.
 *
 * Pinned to the Node.js runtime because it logs through
 * `@sentinel/observability`, which is pino — a Node library that does not run
 * on Next's Edge runtime.
 */
export const runtime = 'nodejs';

/**
 * The `report-uri` wire format: a single `csp-report` object with
 * hyphenated keys. Every field is optional because the set a browser actually
 * sends varies by browser and by violation, and a schema that rejects a
 * report is a schema that loses the signal it exists to collect.
 *
 * `.passthrough()` is deliberately NOT used: unknown keys are dropped rather
 * than logged, so a future browser field cannot put unreviewed content into
 * the log. Every field kept here is a URL, a directive name, a policy string
 * or a line number — none of them a credential — and `blocked-uri` is capped
 * because a `data:` URI arrives here in full.
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

export async function POST(request: Request): Promise<NextResponse> {
  // Browsers send `application/csp-report` (report-uri) rather than
  // `application/json`, so the body is read as text and parsed here instead of
  // relying on `request.json()`'s content-type handling.
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    // A malformed body is not worth a log line at warn — it is almost always a
    // scanner poking the endpoint, and logging it turns the collector into a
    // way to write attacker-chosen text into our logs.
    return new NextResponse(null, { status: 204 });
  }

  const parsed = cspReportSchema.safeParse(payload);
  if (!parsed.success) return new NextResponse(null, { status: 204 });

  logger.warn({ cspReport: parsed.data['csp-report'] }, 'Content Security Policy violation');

  // 204: the browser discards the response body for a report anyway, and
  // returning nothing keeps the endpoint from being usable as a reflector.
  return new NextResponse(null, { status: 204 });
}
