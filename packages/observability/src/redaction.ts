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
];

function keyIsSecret(key: string): boolean {
  const normalised = key.toLowerCase().replaceAll(/[^a-z]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment.replaceAll('_', '')));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
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

  if (value instanceof Error) {
    // Stacks are dropped here; the logger attaches them separately at error
    // level, where they are wanted, rather than everywhere an Error is nested.
    return { name: value.name, message: value.message };
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
    output[key] = keyIsSecret(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return output;
}
