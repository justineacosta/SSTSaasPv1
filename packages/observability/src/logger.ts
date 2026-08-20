import type { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context.js';
import { redact, redactSecretsInText } from './redaction.js';

export type { Logger };

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level: string;
  readonly pretty: boolean;
  readonly silent?: boolean;
  /** Test seam. Production and development both write to stdout. */
  readonly stream?: Writable;
}

// Pino's default key for an Error passed as (or under) the first log
// argument — see lib/proto.js `write()`: a bare Error becomes `{ err }`.
//
// Ideally this would read back whatever `errorKey` the logger was actually
// constructed with, but pino stores it under a private Symbol
// (`errorKeySym`) and does not expose it as a public property on the
// `Logger` instance — confirmed by inspecting a constructed logger at
// runtime, where `logger.errorKey` is `undefined`. Hardcoded, since this
// package never configures `errorKey` to anything other than the default.
const ERROR_KEY = 'err';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Serializer for the `err` key. By the time this runs, pino has already
 * called `formatters.log` (see below) and, for a real `Error` under
 * `ERROR_KEY`, `formatters.log` deliberately left it untouched — this
 * serializer is the only stage of the pipeline that still holds a genuine
 * `Error` instance with a real `.stack`, so it is where that stack gets
 * redacted instead of dropped outright.
 *
 * `pino.stdSerializers.err` is used as a base for its `type`/`message`/
 * `stack`/cause-chain handling and its copy of any custom own properties on
 * the error. Its non-enumerable `.raw` (the original Error) is never copied
 * by object spread, so it never reaches the output. `message` and `stack`
 * are then overwritten with a substring-redacted copy; every other property
 * (including any custom one an application attached to the Error, which
 * could itself be secret-shaped) goes through the normal structural
 * `redact()` used everywhere else.
 */
function redactError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const serialized = pino.stdSerializers.err(error);
  const { message, stack, ...extra } = serialized;
  return {
    ...(redact(extra) as Record<string, unknown>),
    message: redactSecretsInText(message),
    stack: redactSecretsInText(stack),
  };
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    level: options.silent === true ? 'silent' : options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // The merged bindings object passes through structural redaction before
    // it is serialised. Verified empirically: this covers a bare Error (or
    // `{ err }`) passed as the log call's first argument — its message and
    // stack are redacted by the `err` serializer below — and it survives
    // `pretty: true`, because `formatters.log` runs before both the
    // pino-pretty transport and pino's per-key serializers.
    //
    // The error under ERROR_KEY is deliberately excluded from the generic
    // redact() walk here and handed to redactError() untouched: redact()'s
    // own `instanceof Error` branch (used for an Error nested anywhere else
    // in the payload) drops the stack outright because there is no later
    // stage that could redact-and-reattach it for those; ERROR_KEY is the
    // one place that later stage exists.
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const context = getRequestContext();
        const { [ERROR_KEY]: topLevelError, ...rest } = object;
        const redactedRest = redact(rest) as Record<string, unknown>;
        const redacted: Record<string, unknown> =
          topLevelError === undefined
            ? redactedRest
            : {
                ...redactedRest,
                [ERROR_KEY]: topLevelError instanceof Error ? topLevelError : redact(topLevelError),
              };
        return context === undefined ? redacted : { ...context, ...redacted };
      },
    },
    serializers: {
      err: redactError,
    },
    // Covers the other real gaps: pino carries the `msg` string through a
    // path that never reaches `formatters.log` (confirmed by reading
    // lib/tools.js — `serializers[messageKey]` runs independently of the
    // `log` formatter). This hook runs earliest of all, before pino has even
    // decided which argument is the message, so it redacts whichever
    // position holds a string: `logger.info(msg)` or `logger.info(obj, msg)`.
    // Substring redaction, not whole-value: a message is prose, not a
    // secret, and should stay readable around the part that had to go.
    hooks: {
      logMethod(inputArgs, method) {
        // A single-argument call — `logger.error(err)` or
        // `logger.error({ err })` — is the common shape for logging a
        // caught error, and it is also the one pino resolves specially:
        // when no separate message argument is supplied, pino's own
        // write() (lib/proto.js) derives `msg` straight from the raw
        // `err.message` *after* this hook has already run, bypassing every
        // redaction stage below. Preempt that fallback by supplying an
        // explicit, already-redacted message ourselves, so pino's fallback
        // never fires (it only derives `msg` when none was given).
        if (inputArgs.length === 1) {
          const [first] = inputArgs;
          if (first instanceof Error) {
            method.call(this, { [ERROR_KEY]: first }, redactSecretsInText(first.message));
            return;
          }
          if (isRecord(first)) {
            const err = first[ERROR_KEY];
            if (err instanceof Error) {
              method.call(this, first, redactSecretsInText(err.message));
              return;
            }
          }
        }

        if (typeof inputArgs[0] === 'string') {
          inputArgs[0] = redactSecretsInText(inputArgs[0]);
        } else if (inputArgs.length > 1 && typeof inputArgs[1] === 'string') {
          inputArgs[1] = redactSecretsInText(inputArgs[1]);
        }
        method.apply(this, inputArgs);
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
