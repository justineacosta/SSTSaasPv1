import type { Writable } from 'node:stream';
import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type Logger,
  type LoggerOptions,
} from 'pino';
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
 *
 * Residual (not fixed — see the coverage list in task-3-report.md, item I5):
 * this only runs because `serializers.err` is set to this function below. A
 * caller who registers their *own* `err` serializer via `logger.child(...,
 * { serializers: { err: ... } })` (or an equivalent pino API) overrides this
 * one entirely — `formatters.log` still hands the raw, untouched `Error`
 * downstream on the assumption that *some* `err` serializer will run, and if
 * a caller's replaces this one, nothing redacts it.
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

/**
 * Pino resets a child's bindings formatter to an identity function before
 * applying the bindings it was given — confirmed by reading
 * `lib/proto.js`: both branches of `child()` assign
 * `resetChildingsFormatter` before calling `asChindings(instance, bindings)`.
 * A root-level `formatters.bindings` can never see child bindings, by
 * construction, not by omission — there is no configuration-only way to
 * close this. Intercepting `.child()` itself is the only place left.
 *
 * Pino builds children with `Object.create(this)`, so defining `child` as an
 * own property on the root instance is inherited by every descendant through
 * the prototype chain: no recursion is needed here, and `this` binds
 * correctly at each level because the call below is `inheritedChild.call(this, ...)`
 * rather than a captured reference to the root logger.
 */
function wrapChild(logger: Logger): Logger {
  // `child` is generic over pino's custom-levels type parameter, which
  // fights plain assignment and `.call()`'s `this` typing once pulled off
  // the instance as a value. Routing through `unknown` narrows it to the
  // concrete signature this package actually uses (no custom levels) — the
  // underlying function is unchanged, only the static type is. Extracting
  // the method as a value would normally risk losing its `this` binding
  // (`@typescript-eslint/unbound-method`), which is exactly why it is only
  // ever invoked below via `.call(this, ...)`, never called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const inheritedChild = logger.child as unknown as (
    bindings: Bindings,
    options?: ChildLoggerOptions,
  ) => Logger;
  Object.defineProperty(logger, 'child', {
    configurable: true,
    writable: true,
    enumerable: false,
    value(this: Logger, bindings: Bindings, options?: ChildLoggerOptions) {
      return inheritedChild.call(this, redact(bindings) as Bindings, options);
    },
  });
  return logger;
}

/**
 * Builds a Pino JSON logger with structural redaction wired into every
 * stage of the pipeline: the merged per-call object (`formatters.log`), the
 * `msg` string (`hooks.logMethod`), the top-level `err` key's message and
 * stack (`serializers.err`), and `.child()` bindings at any depth
 * (`wrapChild`) — all verified under `pretty: true` too, since that routes
 * through a separate worker-thread transport that only ever sees data that
 * already passed through the stages above.
 *
 * Residual, by deliberate ruling rather than oversight: a secret passed as
 * a trailing printf-style interpolation argument (`logger.info('token=%s',
 * value)`) is covered only by the value-shape backstop —
 * `redactInterpolationArg` runs `redactSecretsInText` (strings) or
 * `redact()` (objects) on it before pino substitutes it into the formatted
 * message — because that position carries no key name to match against
 * `SECRET_KEY_FRAGMENTS`. A secret that isn't one of the five recognised
 * shapes (bearer token, JWT, credentialed URL, Stripe-style key, PEM block)
 * — a plain password, an opaque internal token — is indistinguishable from
 * an ordinary interpolated value and is not redacted. Reimplementing pino's
 * `%s`/`%d`/`%j`/`%o` formatting ourselves to close that fully was
 * considered and rejected: maintaining a second copy of pino's
 * interpolation semantics is a worse failure mode than the residual gap it
 * would close. Full coverage list, including this and other residuals
 * (I5, I6), lives in task-3-report.md.
 */
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
      // This formatter does NOT protect `.child()` bindings, despite the
      // name — confirmed by reading pino's own `child()` (lib/proto.js):
      // both branches assign `resetChildingsFormatter` (the identity
      // function) before applying a child's bindings, discarding whatever
      // this was configured to. A root-level `formatters.bindings` can
      // never see child bindings, by construction, not by omission. What
      // this formatter actually covers is narrow: this root logger's own
      // `base` bindings only (`{ service }`, which never carries a secret
      // in this package's design). Child bindings — the case that matters,
      // since `.child()` is this codebase's expected way to attach
      // `organizationId`/`requestId` per request — are instead redacted by
      // wrapping `.child` itself; see `wrapChild` below.
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
      log: (object) => {
        const context = getRequestContext();
        // Built with the same guarded read `redact()` uses internally,
        // rather than `const { [ERROR_KEY]: topLevelError, ...rest } =
        // object`: rest-destructuring reads every own enumerable property
        // up front, *before* redact() ever runs, which invokes a throwing
        // getter outside any try/catch — the object-spread equivalent of
        // the bug the try/catch below exists to prevent, at exactly the
        // position most likely to be hit (the top-level merge object).
        let topLevelError: unknown;
        const rest: Record<string, unknown> = {};
        for (const key of Object.keys(object)) {
          let item: unknown;
          try {
            item = object[key];
          } catch {
            item = '[unreadable]';
          }
          if (key === ERROR_KEY) {
            topLevelError = item;
          } else {
            rest[key] = item;
          }
        }
        const redactedRest = redact(rest) as Record<string, unknown>;
        const redacted: Record<string, unknown> =
          topLevelError === undefined
            ? redactedRest
            : {
                ...redactedRest,
                [ERROR_KEY]: topLevelError instanceof Error ? topLevelError : redact(topLevelError),
              };
        // Context last: a log-call field with the same name as a
        // correlation ID (`requestId`, `organizationId`, ...) must not be
        // able to shadow it — those IDs are what makes a customer's report
        // traceable to one request, and a caller-controlled override would
        // silently break that traceability. Spreading `redacted` first and
        // `context` last means context always wins on a key collision.
        return context === undefined ? redacted : { ...redacted, ...context };
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
    // Trailing interpolation arguments are covered too, with the narrower
    // value-shape-only guarantee documented on `createLogger` above.
    hooks: {
      logMethod(inputArgs, method) {
        // `logger.error(err)` / `logger.error({ err })` — logging a caught
        // error with no separate message string — is the common shape, and
        // also the one pino resolves specially: when no message argument is
        // *given*, pino's own write() (lib/proto.js) derives `msg` straight
        // from the raw `err.message` *after* this hook has already run,
        // bypassing every redaction stage below. Gated on whether a string
        // message is present at all, not on argument count: an explicit
        // `logger.error(err, undefined)` — e.g. `logger.error(err,
        // exception.message)` when that message is absent — has length 2,
        // but inputArgs[1] still isn't a string, so pino's fallback still
        // fires unless this branch also catches it. Preempt that fallback by
        // supplying an explicit, already-redacted message ourselves, so
        // pino's fallback never has a reason to run.
        if (typeof inputArgs[1] !== 'string') {
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

  if (options.stream !== undefined) return wrapChild(pino(base, options.stream));

  if (options.pretty) {
    return wrapChild(
      pino({
        ...base,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
    );
  }

  return wrapChild(pino(base));
}
