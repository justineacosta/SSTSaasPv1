import { NextResponse } from 'next/server';
import { parseCspReport, readBoundedBody } from '../../../src/csp-report';
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
 * Everything this route decides about a body lives in `src/csp-report.ts` and
 * is asserted in `src/csp-report.spec.ts`. That is not tidiness: this handler
 * answers 204 to every input, so no HTTP-level test can tell a working
 * collector from an empty one.
 *
 * Pinned to the Node.js runtime because it logs through
 * `@sentinel/observability`, which is pino — a Node library that does not run
 * on Next's Edge runtime.
 */
export const runtime = 'nodejs';

/** Always 204, for every input. See the docblock above. */
const noContent = (): NextResponse => new NextResponse(null, { status: 204 });

export async function POST(request: Request): Promise<NextResponse> {
  // Browsers send `application/csp-report` (report-uri) rather than
  // `application/json`, so the body is read as text and parsed by hand rather
  // than through `request.json()`'s content-type handling.
  const body = await readBoundedBody(request);
  if (body === null) return noContent();

  const result = parseCspReport(body);
  // A malformed or non-conforming body is not worth a log line at warn — it is
  // almost always a scanner poking the endpoint, and logging it turns the
  // collector into a way to write attacker-chosen text into our logs.
  if (!result.ok) return noContent();

  logger.warn({ cspReport: result.report }, 'Content Security Policy violation');

  // 204: the browser discards the response body for a report anyway, and
  // returning nothing keeps the endpoint from being usable as a reflector.
  return noContent();
}
