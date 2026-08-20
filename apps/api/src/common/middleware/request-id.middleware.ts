import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '@sentinel/db';
import { runWithRequestContext } from '@sentinel/observability';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A client-supplied request ID is accepted only in this shape.
 *
 * The value is written into structured JSON logs and reflected back in a
 * response header, so it is untrusted input with two sinks. A newline forges a
 * second log line; an unbounded value is a cheap way to bloat every log record
 * for a request. Anything outside this alphabet is discarded and replaced with
 * a generated ID rather than sanitised — a half-honoured correlation ID is
 * worse than an honest new one, because the caller believes it can correlate.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

declare module 'express' {
  interface Request {
    /** Set by `RequestIdMiddleware`, first in the pipeline. */
    id?: string;
  }
}

/**
 * Stage one of the cross-cutting pipeline (architecture/backend.md §3).
 *
 * Accepts an upstream `x-request-id` when it is well-formed so a trace that
 * started at the edge stays one trace, generates one otherwise, echoes it, and
 * runs the remainder of the request inside `runWithRequestContext` so every log
 * line correlates without the ID being threaded through call signatures.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const supplied = request.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : newId('req');

    request.id = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    runWithRequestContext({ requestId }, next);
  }
}
