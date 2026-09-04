import { errorEnvelopeSchema, fieldErrorSchema, type FieldError } from '@sentinel/contracts';
import { z } from 'zod';

/**
 * Why a request did not produce a value.
 *
 * - `api` — the server answered, and the body parsed as the shared error
 *   envelope. `code`, `message` and `requestId` are all present and are the
 *   server's own.
 * - `malformed` — the server answered, and the body did not parse: either it
 *   was not the envelope on a failure, or it was not the endpoint's response
 *   schema on a success. **This is an error, not a value.** The alternative is
 *   casting an unknown shape into a typed one and discovering the mismatch
 *   three components later, in a render, as `undefined is not an object`.
 * - `network` — no answer at all: offline, DNS, TLS, a CORS preflight the
 *   browser refused, or an abort.
 */
export type ApiFailureKind = 'api' | 'malformed' | 'network';

/**
 * The one error type every call in this app rejects with.
 *
 * `architecture/frontend.md` §6 requires the **request ID** in every error
 * state, because it is the only thing support can use to find the request in
 * the API's logs. It is therefore a field here rather than something a screen
 * digs out of a body, and it is `null` exactly when the server did not give us
 * one (a network failure, or a body that did not parse).
 */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  /** HTTP status, or `null` when there was no response. */
  readonly status: number | null;
  /** The `ERROR_CODES` value, or `null` for `malformed` and `network`. */
  readonly code: string | null;
  /** `error.requestId` from the envelope, or `null`. */
  readonly requestId: string | null;
  /** `error.details.fields`, already parsed. Empty when there were none. */
  readonly fieldErrors: readonly FieldError[];

  constructor(init: {
    kind: ApiFailureKind;
    message: string;
    status?: number | null;
    code?: string | null;
    requestId?: string | null;
    fieldErrors?: readonly FieldError[];
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
    this.fieldErrors = init.fieldErrors ?? [];
  }
}

/**
 * `details.fields` as the validation pipe builds it
 * (`apps/api/src/common/pipes/zod-validation.pipe.ts`), carried under that key
 * for both `VALIDATION_ERROR` and `UNKNOWN_FIELD`.
 *
 * Parsed with the shared `fieldErrorSchema` rather than a local shape, and
 * parsed *leniently*: `details` is `z.record(z.unknown())` on the envelope, so
 * an endpoint is free to put something else under `fields`. A malformed
 * `fields` costs the field-level mapping, not the whole error message.
 */
const fieldsDetailSchema = z.array(fieldErrorSchema);

export function readFieldErrors(details: Record<string, unknown> | undefined): FieldError[] {
  if (details === undefined) return [];
  const parsed = fieldsDetailSchema.safeParse(details['fields']);
  return parsed.success ? parsed.data : [];
}

/**
 * Turns a non-2xx response body into an {@link ApiError}.
 *
 * A body that is not the envelope produces `kind: 'malformed'` carrying the
 * status, never a fabricated code. Inventing `INTERNAL_ERROR` here would put a
 * value in `code` that no server ever sent, and every later `code === ...`
 * comparison would be reasoning about this function rather than about the API.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return new ApiError({
      kind: 'malformed',
      status,
      message: `The server returned an unexpected error response (HTTP ${String(status)}).`,
    });
  }
  const { error } = parsed.data;
  return new ApiError({
    kind: 'api',
    status,
    code: error.code,
    message: error.message,
    requestId: error.requestId,
    fieldErrors: readFieldErrors(error.details),
  });
}
