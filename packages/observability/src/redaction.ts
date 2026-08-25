export const REDACTED = '[redacted]';

/**
 * Key fragments that mark a value as secret. Matched case-insensitively as a
 * substring, so `mfaSecret`, `X_CSRF_TOKEN`, and `stripeWebhookSecret` are all
 * caught without enumerating every spelling.
 *
 * Source list: .claude/operations/monitoring.md §2.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'privatekey',
  'private_key',
  'sessionid',
  'session_id',
  'mfasecret',
] as const;

/**
 * Value-shape backstop. Redaction is structural first — these patterns exist
 * only to catch a secret that arrived under an innocent key name, which is the
 * case a key denylist alone cannot see.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, // bearer tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWTs
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i, // any URL with inline credentials
  /\b(?:sk|rk|whsec)_[A-Za-z0-9]{16,}/, // Stripe-style keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM material
  // A credential carried as a URL query or fragment parameter.
  //
  // Added after measuring the gap, not on suspicion. `SECRET_KEY_FRAGMENTS`
  // above already catches `{ token: '<raw>' }`, so a spec written that way is
  // green whatever the token looks like. The shape that actually reaches a log
  // line is the verification or reset link under an innocent key —
  // `{ verifyUrl: 'https://app/auth/verify?token=<43 chars of base64url>' }`,
  // the same string in a `msg`, or the same string as a `%s` argument — and
  // none of the five patterns above matches a bare base64url value. Measured
  // 2026-08-26 against a real 256-bit token: three of those four shapes emitted
  // the token verbatim. A token in a log is a password reset for anyone with
  // log access, so this is the backstop for the one place a key name cannot
  // help.
  //
  // Lookbehind rather than a capture group so `redactSecretsInText` replaces
  // only the value: `?token=[redacted]` keeps the sentence and the route
  // readable, which is what that function's docblock promises. In `redact()`
  // the whole string is replaced instead, because a structured field that
  // matches is a field whose entire contents are suspect.
  //
  // `{8,}` is the false-positive guard: a two-letter `?code=US` is not a
  // credential. The parameter names are the ones this product's credentials
  // actually travel under (§6 tokens, API keys); a name not on this list is not
  // covered, and a bare `token=` outside a URL is not covered either — both are
  // residual, and neither is the shape Task 5 builds.
  //
  // **`key` and `code` were on this list for one round and were removed**
  // (Task 4 review, M2). In `redact()` a match replaces the ENTIRE structured
  // field, not the matched span, so `?key=` would have blanked whole URLs — and
  // `?key=` is the shape an object-storage URL takes, in a product whose entire
  // evidence subsystem is built on object keys prefixed `org/{organizationId}/`.
  // `?code=` collides with this repository's own SCREAMING_SNAKE error codes,
  // every one of which clears the eight-character floor. Both were measured
  // blanking realistic non-credentials. The cost of removing them is an OAuth
  // authorization code in a query string, which nothing issues today; Phase 11
  // owns re-adding `code` with a shape that excludes an all-caps error name.
  // Over-redaction is not the safe direction here — a log the operator cannot
  // read is the failure `redactSecretsInText`'s docblock argues against.
  /(?<=[?&#](?:access_token|refresh_token|id_token|token|api_key|apikey|password|passwd|secret|signature)=)[^&\s"'#]{8,}/i,
];

function keyIsSecret(key: string): boolean {
  const normalised = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment.replaceAll('_', '')));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

// Global-flagged copies of the same patterns, for substring replacement
// rather than whole-value matching. `String.prototype.replace` resets a
// global regex's `lastIndex` to 0 on every call (ECMA-262 22.2.6.11 step 8),
// so reusing these across calls is safe.
const GLOBAL_SECRET_VALUE_PATTERNS: RegExp[] = SECRET_VALUE_PATTERNS.map(
  (pattern) =>
    new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
);

/**
 * Substring redaction for free text — log messages and error text — where the
 * value is prose that may *contain* a secret rather than being one outright.
 * Unlike `redact()`'s whole-value backstop for structured fields, this
 * replaces only the matched span, so `"exchanging token=Bearer xyz now"`
 * becomes `"exchanging token=[redacted] now"` instead of disappearing
 * entirely — replacing the whole message would trade a credential leak for
 * an unreadable log, and an operator debugging a failure still needs the
 * rest of the sentence.
 *
 * Accepts `unknown`, not `string`: an `Error.message` is conventionally a
 * string but is not guaranteed to be one (a plain assignment or a hostile
 * getter can make it anything). A non-string here fails closed — returns
 * `REDACTED` rather than crashing — because this runs on the error-logging
 * path, and a logger that throws while reporting a failure hides the real
 * one. Deliberately not `String(text)`: a hostile `toString`/`Symbol.toPrimitive`
 * can itself throw, which would put us right back where we started.
 */
export function redactSecretsInText(text: unknown): string {
  if (typeof text !== 'string') return REDACTED;
  let result = text;
  for (const pattern of GLOBAL_SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

const MAX_DEPTH = 12;

/**
 * Deep, structural redaction. Walks the object graph and redacts by key name,
 * with a value-shape backstop.
 *
 * This is deliberately NOT a regex over the final serialised string: by the
 * time a log line is a string, the structure that tells you which field held a
 * credential is gone, and a string-level regex either misses secrets or mangles
 * legitimate content such as an evidence payload.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') return valueLooksSecret(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  // Date has no own enumerable properties, so the generic object walk below
  // would otherwise silently reduce every Date to `{}` — a real regression
  // against stock pino, and dates are common in log payloads (timestamps,
  // expiries). Preserved as the same ISO string `JSON.stringify` would have
  // produced anyway; a Date can never itself be secret-shaped.
  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    // Stacks are dropped here; the logger attaches them separately at error
    // level, where they are wanted, rather than everywhere an Error is nested.
    // The message is still text-scanned: an Error nested anywhere else in a
    // payload (not under the top-level err key, which gets its own
    // serializer in logger.ts) has no other stage that will ever see it.
    return { name: value.name, message: redactSecretsInText(value.message) };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    let item: unknown;
    try {
      // A getter can throw (e.g. a lazily-computed property backed by a
      // resource that is no longer available). Logging happens on the error
      // path, so a hostile or broken getter must not crash the logger and
      // hide the real failure.
      item = (value as Record<string, unknown>)[key];
    } catch {
      output[key] = '[unreadable]';
      continue;
    }
    // An own-enumerable function survives redaction unchanged (it isn't a
    // string or a plain object), but if it happens to be named `toJSON`,
    // JSON.stringify calls it during serialisation and uses whatever it
    // returns *instead of* this already-redacted object — silently
    // resurrecting the original, unredacted value at serialisation time,
    // including under a key that matched the denylist. Dropped outright:
    // a *prototype*-based `toJSON` (a class instance method, not an own
    // property) is untouched, since `Object.keys` never sees it, and JSON
    // serialisation already drops a top-level function property regardless,
    // so nothing legitimate is lost by dropping it here too. This does NOT
    // mean every prototype-`toJSON` type round-trips cleanly through this
    // walk: `Date` is special-cased above specifically because it does not;
    // `URL` is not special-cased and still collapses to `{}` here for the
    // same underlying reason `Date` used to — a pre-existing gap, unrelated
    // to dropping functions, not fixed by this change (see the coverage
    // list in task-3-report.md).
    if (typeof item === 'function') continue;
    output[key] = keyIsSecret(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return output;
}
