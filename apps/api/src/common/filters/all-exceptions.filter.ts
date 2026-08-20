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

const GENERIC_MESSAGE =
  'Something went wrong on our side. Quote the request ID if you contact support.';

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
      const code = STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL_ERROR;
      return {
        status,
        code,
        message: status >= 500 ? GENERIC_MESSAGE : redactSecretsInText(exception.message),
      };
    }

    return { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: GENERIC_MESSAGE };
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
