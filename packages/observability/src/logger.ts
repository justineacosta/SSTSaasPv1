import type { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context.js';
import { redact } from './redaction.js';

export type { Logger };

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly pretty: boolean;
  readonly silent?: boolean;
  /** Test seam. Production and development both write to stdout. */
  readonly stream?: Writable;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.silent === true ? 'silent' : options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // The merged bindings object passes through structural redaction before
    // it is serialised. Verified empirically: this also covers a bare Error
    // (or `{ err }`) passed as the log call's first argument, and it survives
    // `pretty: true`, because pino's `formatters.log` hook runs before the
    // pino-pretty transport and before pino's own error serializer.
    //
    // Known gap, not covered by this hook: pino handles the `msg` string
    // through a separate path that never reaches `formatters.log`, and an
    // Error's `.message` (kept verbatim by the `instanceof Error` branch in
    // redact()) is not re-scanned for secret value shapes. A secret written
    // directly into a message string — `logger.info(\`token=${t}\`)` or
    // `new Error(\`auth failed: Bearer ${t}\`)` — is not redacted. Callers
    // must put secret-shaped values in the object argument, never in message
    // text. See task-3-report.md for the probes that established this.
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const context = getRequestContext();
        const redacted = redact(object) as Record<string, unknown>;
        return context === undefined ? redacted : { ...context, ...redacted };
      },
    },
  };

  if (options.stream !== undefined) return pino(base, options.stream);

  if (options.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    });
  }

  return pino(base);
}
