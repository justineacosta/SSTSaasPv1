import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@sentinel/contracts';
import { redact, redactSecretsInText } from '@sentinel/observability';
import { DomainError } from '../errors/domain-error.js';

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
}

/**
 * The narrow slice of the structured logger this filter uses. Declared here
 * rather than importing pino's `Logger` so a test can supply a recorder without
 * standing up a real transport — pino's `Logger` is structurally assignable to
 * it, so the production wiring passes the real thing unchanged.
 */
export interface ErrorLogger {
  error(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
}

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ERROR_CODES.VALIDATION_ERROR,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.PERMISSION_DENIED,
  404: ERROR_CODES.RESOURCE_NOT_FOUND,
  409: ERROR_CODES.DUPLICATE_RESOURCE,
  422: ERROR_CODES.INVALID_STATE_TRANSITION,
  429: ERROR_CODES.RATE_LIMITED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * The code for a status the table above does not name.
 *
 * `INTERNAL_ERROR` for everything unmapped was wrong for the 4xx half: errors.md
 * §3 files that code under **Server**, and §1 says clients branch on `code` and
 * never on `message` — so a 405, 406, 413 or 415 labelled `INTERNAL_ERROR` tells
 * a client to retry its own bad request as though the server were at fault.
 * Any unmapped client-class status therefore falls back to `VALIDATION_ERROR`,
 * which sits in the Validation group and honestly means "your request was not
 * acceptable". Server-class statuses keep `INTERNAL_ERROR`.
 *
 * The trade, recorded deliberately: a 413 arrives as `VALIDATION_ERROR` with no
 * `details.fields`, which is a weaker signal than a dedicated code would be.
 * Adding `PAYLOAD_TOO_LARGE`/`UNSUPPORTED_MEDIA_TYPE` to `ERROR_CODES` was
 * considered and rejected for now — Task 11 generates OpenAPI from that
 * contract and errors.md §7 wants a test that produces every documented code,
 * so a code with no endpoint behind it costs more than it pays. The property
 * that matters here is client-class versus server-class, and this delivers it.
 * Revisit in Phase 2, when there are real endpoints to raise them.
 */
function codeForStatus(status: number): ErrorCode {
  // The range is checked at both ends deliberately. `status < 500` alone would
  // also claim 1xx-3xx, and a 204 or a 302 arriving at an exception filter is
  // not a client mistake — it is a bug on this side, which is what
  // `INTERNAL_ERROR` is for. Nothing constructs a sub-400 `HttpException`
  // today, so this costs nothing; it is here so the rule and the comment above
  // stay the same statement.
  const isClientClass = status >= 400 && status < 500;
  return (
    STATUS_TO_CODE[status] ??
    (isClientClass ? ERROR_CODES.VALIDATION_ERROR : ERROR_CODES.INTERNAL_ERROR)
  );
}

/** The two halves of the `http-errors` contract this filter is willing to trust. */
interface HttpErrorLike {
  readonly status: number;
  readonly expose: boolean;
}

/**
 * Recognises a throwable from the `http-errors` library, which is what
 * `body-parser` raises and Express propagates: a payload over the size limit, an
 * unsupported `Content-Encoding`, a bad `Content-Type`. None of these are Nest
 * `HttpException`s, and Nest's own `mapExternalException` converts only
 * `SyntaxError` and `URIError` — so left alone they reach the catch-all below
 * and a 413 is served as a 500. That is dishonest to the client (errors.md §4)
 * and lets any caller drive the 5xx rate that monitoring.md §6 alerts on.
 *
 * The check is deliberately narrow. A `status` alone is not enough: Prisma,
 * AWS SDK and node-fetch errors all carry status-shaped properties, and
 * trusting those would let a driver choose this API's HTTP status. Both halves
 * of the `http-errors` contract must be present — an integer status in the
 * 400–599 range **and** a boolean `expose` — before the value is honoured.
 */
function asHttpError(exception: unknown): HttpErrorLike | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;

  // Every read is guarded, for the same reason `redact()` guards its own in
  // packages/observability/src/logger.ts: these are properties of a value this
  // filter did not construct, and a getter that throws would propagate out of
  // `catch()` itself — replacing the error envelope with the framework's
  // default handler output. A filter that throws while reporting a failure
  // hides the original failure, which is the one thing it must never do.
  // Unreadable is treated as absent, so the value simply is not trusted.
  const read = (key: 'status' | 'statusCode' | 'expose'): unknown => {
    try {
      return (exception as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };

  const expose = read('expose');
  if (typeof expose !== 'boolean') return undefined;
  const rawStatus = read('status');
  const status = typeof rawStatus === 'number' ? rawStatus : read('statusCode');
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    return undefined;
  }
  return { status, expose };
}

/**
 * Two generic messages, not one, and they must stay two.
 *
 * `SERVER_GENERIC_MESSAGE` is what replaces a 5xx whose text this codebase did
 * not author. `CLIENT_GENERIC_MESSAGE` is what replaces a 4xx whose text is not
 * safe to repeat — an `http-errors` throwable with `expose: false`. Collapsing
 * them would tell a caller that their own bad request was the server's fault,
 * which is the same confusion the client-class/server-class split in
 * `codeForStatus` exists to remove (errors.md §1, §3) and exactly the sort of
 * contradiction that turns into a support ticket (errors.md §4). The rule is
 * written down in errors.md §5 so it survives a later tidy-up.
 *
 * Neither message speculates about the cause: for `expose: false` the whole
 * point is that the underlying text is not trusted, so the client-class string
 * says the request was not acceptable and stops there. The `code` and the
 * status carry the machine-readable part; the request ID carries the rest, in
 * the log.
 */
const SERVER_GENERIC_MESSAGE =
  'Something went wrong on our side. Quote the request ID if you contact support.';

const CLIENT_GENERIC_MESSAGE =
  'The request could not be accepted. Quote the request ID if you contact support.';

interface RequestLike {
  id?: string;
  url?: string;
  originalUrl?: string;
  method?: string;
}

/**
 * One envelope for every error, without exception. api/errors.md §1.
 *
 * Three properties this file exists to hold, each covered by a test that goes
 * red if the corresponding line is removed:
 *
 * 1. **No 5xx that this codebase did not author carries a message.** Not just
 *    the unrecognised-throwable branch: `new InternalServerErrorException(
 *    err.message)` and `new ServiceUnavailableException(...)` are ordinary Nest
 *    idioms that would otherwise ride the `HttpException` branch with an
 *    internal message intact, so status decides there, not exception class.
 *    A `DomainError` is the deliberate exception — `DEPENDENCY_UNAVAILABLE` at
 *    503 exists precisely to name the dependency that is down (errors.md §3),
 *    and its text is written here, not by a driver. errors.md §5.
 * 2. **Client-visible 4xx text passes through `redactSecretsInText`.** A 4xx
 *    message is authored, so this is a backstop rather than the primary
 *    control — but the authored text sometimes quotes user input (a rejected
 *    callback URL), and a credentialed URL is exactly the shape that arrives
 *    that way. `details` goes through the structural `redact()` for the same
 *    reason.
 * 3. **Nothing but `code`/`message`/`requestId`/`details` is serialised.** The
 *    envelope is built field by field; the exception is never spread. A Prisma
 *    error's `code`, `meta`, and `clientVersion` therefore cannot leak by
 *    accident when a new error class turns up.
 *
 * Everything withheld from the client goes to the log instead, correlated by
 * the request ID: 5xx at `error` with the full `Error` (the logger's own `err`
 * serialiser redacts its message and stack), 4xx at `warn` with the code and
 * path only — never the request body, which on an auth endpoint is a
 * credential. errors.md §6.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /**
   * `logger` is optional so a unit test can construct the filter bare. In the
   * application it is always supplied; see `app.module.ts`.
   */
  constructor(private readonly logger?: ErrorLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const requestId = request.id ?? 'req_unknown';
    const response = http.getResponse<ResponseLike>();

    const { status, code, message, details } = this.classify(exception);

    this.log(exception, { requestId, status, code, request });

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message,
        requestId,
        ...(details === undefined ? {} : { details }),
      },
    };
    response.status(status).json(envelope);
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof DomainError) {
      // A DomainError is authored, including the 5xx ones — DEPENDENCY_UNAVAILABLE
      // and SERVICE_UNAVAILABLE are documented codes in errors.md §3 that exist
      // precisely so a caller learns which dependency is down. Its message and
      // details are therefore returned, not replaced. The residual duty that
      // creates: never construct a DomainError out of driver output. The
      // redaction below is a backstop for that, not a licence.
      return {
        status: exception.status,
        code: exception.code,
        message: redactSecretsInText(exception.message),
        ...(exception.details === undefined
          ? {}
          : { details: redact(exception.details) as Record<string, unknown> }),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: codeForStatus(status),
        message: status >= 500 ? SERVER_GENERIC_MESSAGE : redactSecretsInText(exception.message),
      };
    }

    const httpError = asHttpError(exception);
    if (httpError !== undefined) {
      // `expose` is the library's own statement about whether its message is
      // safe for a client; it is false for every 5xx it builds. Combining it
      // with the status keeps property 1 of this file intact — no 5xx this
      // codebase did not author carries a message — while letting a
      // client-caused failure say what the client did wrong.
      const usesOwnMessage =
        httpError.expose && httpError.status < 500 && exception instanceof Error;
      const withheld = httpError.status < 500 ? CLIENT_GENERIC_MESSAGE : SERVER_GENERIC_MESSAGE;
      return {
        status: httpError.status,
        code: codeForStatus(httpError.status),
        message: usesOwnMessage ? redactSecretsInText(exception.message) : withheld,
      };
    }

    return { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: SERVER_GENERIC_MESSAGE };
  }

  private log(
    exception: unknown,
    context: { requestId: string; status: number; code: ErrorCode; request: RequestLike },
  ): void {
    const logger = this.logger;
    if (logger === undefined) return;

    const bindings = {
      requestId: context.requestId,
      statusCode: context.status,
      code: context.code,
      method: context.request.method,
      path: context.request.originalUrl ?? context.request.url,
    };

    // A logger that throws while reporting a failure hides the real one, and
    // would here also abort the response the client is waiting for. Failing to
    // log is bad; failing to answer is worse.
    try {
      if (context.status >= 500) {
        const raw = exception instanceof Error ? exception.message : 'Unhandled exception';
        logger.error({ ...bindings, err: exception }, redactSecretsInText(raw));
        return;
      }
      logger.warn(bindings, `Request failed with ${context.code}`);
    } catch {
      // Deliberately swallowed. Nothing here can be reported anywhere.
    }
  }
}
