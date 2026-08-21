import { NextResponse } from 'next/server';

/**
 * Liveness for the web origin: is this Node process up and serving?
 *
 * Deliberately narrow. It checks nothing else — not the API, not the
 * database — because a liveness probe that depends on a backing service will
 * restart a healthy web server when that service has a bad minute. The API's
 * `/health/ready` and `/health/detailed` are where dependency health is
 * answered, and they already do it against the real stack.
 *
 * `force-dynamic` because a health probe that Next prerendered at build time
 * would answer "up" from a static file forever, including from a process that
 * had stopped working.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): NextResponse {
  return NextResponse.json(
    { status: 'ok' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
