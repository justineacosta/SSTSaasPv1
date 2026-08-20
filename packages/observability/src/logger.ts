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
 * Redaction for a trailing printf-style interpolation argument
 * (`logger.info('token=%s', value)`). Unlike a field in the merged bindings
 * object, this position carries no key name to match against
 * `SECRET_KEY_FRAGMENTS` — an opaque high-entropy string here is
 * indistinguishable from a scan ID. Only the value-shape backstop applies:
 * substring redaction for a string, full structural `redact()` for an
 * object (which does have field names to match once inside it). Numbers,
 * booleans, and other primitives pass through unchanged.
 */
function redactInterpolationArg(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (typeof value === 'object' && value !== null) return redact(value);
  return value;
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
      // Bindings (the object passed to `.child()`) are a separate pipeline
      // from the per-call `log` formatter below: `log` never sees them, so
      // they cannot be double-redacted by both — confirmed by inspecting a
      // captured line from a child logger directly, which contains no
      // trace of the bindings object passed to `formatters.log`.
      //
      // KNOWN LIMITATION, confirmed by reading pino's own `child()`
      // (lib/proto.js): for the ordinary single-argument call —
      // `logger.child({ apiKey: secret })`, the shape this codebase will
      // actually use — pino's own performance fast path explicitly resets
      // the child's bindings formatter to the identity function
      // (`resetChildingsFormatter`) and does NOT reuse this one, so this
      // hook never runs for that call at all. It only takes effect for (a)
      // this root logger's own `base` bindings, which never carry a secret
      // in this package's design, and (b) a child created with its own
      // `formatters.bindings` explicitly re-supplied via a second argument
      // to `.child()`, which nothing in this codebase does. This was
      // proven by reading pino's source and by direct probes; it is not
      // reasoned about. There is no `redact()`-only way to close this for
      // the ordinary call — doing so needs either wrapping the returned
      // `Logger`'s own `.child` method (a materially larger change than
      // this one-line hook, not attempted here) or a convention/lint rule
      // banning secrets in `.child()` bindings. See task-3-report.md.
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
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
    //
    // Trailing printf-style interpolation arguments (`logger.info('token=%s',
    // value)`) also pass through `redactInterpolationArg` before pino
    // substitutes them into the formatted message. This is a narrower
    // guarantee than the rest of this hook: those positions carry no key
    // name to match against `SECRET_KEY_FRAGMENTS`, so only the value-shape
    // backstop applies — a shape the backstop does not recognise (a plain
    // password, an opaque internal ID) is not distinguishable from an
    // ordinary interpolated value and is not redacted. Reimplementing pino's
    // `%s`/`%d`/`%j`/`%o` formatting ourselves to close that fully was
    // considered and rejected: it would mean maintaining a second copy of
    // pino's interpolation semantics, which is a worse failure mode than the
    // residual gap it would close.
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
          for (let i = 1; i < inputArgs.length; i++) {
            inputArgs[i] = redactInterpolationArg(inputArgs[i]);
          }
        } else if (inputArgs.length > 1 && typeof inputArgs[1] === 'string') {
          inputArgs[1] = redactSecretsInText(inputArgs[1]);
          for (let i = 2; i < inputArgs.length; i++) {
            inputArgs[i] = redactInterpolationArg(inputArgs[i]);
          }
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
