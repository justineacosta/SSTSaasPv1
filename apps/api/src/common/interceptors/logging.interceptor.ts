import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, tap } from 'rxjs';
import { LOGGER } from '../../infrastructure/tokens.js';

/**
 * The slice of the structured logger this interceptor uses. Pino's `Logger` is
 * structurally assignable to it; a test supplies a recorder instead.
 */
export interface RequestLogger {
  info(bindings: object, message: string): void;
}

interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  id?: string;
}

/**
 * Strips the query string. A query string is where invitation tokens, password
 * reset tokens, and API keys pasted into the wrong place turn up, and a log
 * line is exactly the wrong place for those to be durable.
 * monitoring.md §2, api/errors.md §6.
 */
function pathOf(request: RequestLike): string {
  const raw = request.originalUrl ?? request.url ?? '';
  const queryStart = raw.indexOf('?');
  return queryStart === -1 ? raw : raw.slice(0, queryStart);
}

/**
 * One structured line per completed request: method, path, status, duration.
 *
 * Deliberately narrow. Bodies and headers are never logged — the login endpoint
 * alone makes that a credential leak — and the correlation IDs are not written
 * here either, because `runWithRequestContext` already merges them into every
 * line the logger emits (`packages/observability/src/logger.ts`,
 * `formatters.log`).
 *
 * Failures are not logged here. The exception filter logs them, with the status
 * code it decided; an interceptor sees the error before the filter has set one,
 * so a line written here would record every failure as a 200 and would
 * double-count it against the error rate.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(LOGGER) private readonly logger: RequestLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = process.hrtime.bigint();
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();

    return next.handle().pipe(
      tap({
        next: () => {
          const response = http.getResponse<{ statusCode?: number }>();
          this.logger.info(
            {
              method: request.method,
              path: pathOf(request),
              statusCode: response.statusCode,
              durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            },
            'Request completed',
          );
        },
      }),
    );
  }
}
