import type { LoggerService } from '@nestjs/common';
import { redactSecretsInText } from '@sentinel/observability';

/** The slice of the structured logger this bridge writes to. */
export interface BridgeableLogger {
  debug(bindings: object, message: string): void;
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
  fatal(bindings: object, message: string): void;
}

/**
 * Renders a value Nest handed us as a message string, without ever invoking a
 * `toString` we do not control — the same failure mode
 * `redactSecretsInText` guards against, for the same reason: a logger that
 * throws while reporting a failure hides the failure.
 */
function messageOf(value: unknown): string {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (value instanceof Error) return redactSecretsInText(value.message);
  try {
    return redactSecretsInText(JSON.stringify(value) ?? '[unserialisable]');
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Routes NestJS's own output through the structured logger.
 *
 * Without this, a process emits two kinds of line: Nest's human-formatted
 * bootstrap and exception output, and everything else as JSON. monitoring.md §2
 * is unambiguous — "Structured JSON. Never plain strings" — and a log shipper
 * that has to parse two formats parses one of them badly. It also matters for
 * redaction: Nest's `ExceptionsHandler` logs the errors it catches, and left to
 * itself it would write an unredacted stack straight to stdout.
 *
 * `optionalParams` is where Nest puts its context tag (`RoutesResolver`,
 * `NestApplication`, …). It becomes a binding rather than part of the message,
 * so it is filterable.
 */
export class NestLoggerBridge implements LoggerService {
  constructor(private readonly logger: BridgeableLogger) {}

  private write(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const context = optionalParams.find((param) => typeof param === 'string');
    const bindings: Record<string, unknown> = {};
    if (context !== undefined) bindings.nestContext = context;
    if (message instanceof Error) bindings.err = message;
    this.logger[level](bindings, messageOf(message));
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  /** Nest's `verbose` sits below `debug`; pino has no level below it. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }
}
