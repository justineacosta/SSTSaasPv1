import type { FieldError } from '@sentinel/contracts';
import { ApiError } from './errors';

/**
 * The first segment of a `details.fields` path.
 *
 * `api/errors.md` §2 gives paths in dotted/bracketed notation — `email`,
 * `targets[0]`, `scope.rules[2].value` — so a form whose control is named
 * `targets` still has to recognise `targets[0]` as its own. Matching only the
 * exact string would drop the nested cases into the form-level bucket, where
 * they are true but useless.
 */
export function rootSegment(path: string): string {
  const dot = path.indexOf('.');
  const bracket = path.indexOf('[');
  const boundaries = [dot, bracket].filter((index) => index !== -1);
  if (boundaries.length === 0) return path;
  return path.slice(0, Math.min(...boundaries));
}

export interface MatchedFieldError<TField extends string> {
  readonly field: TField;
  readonly message: string;
}

export interface DistributedFieldErrors<TField extends string> {
  /** Errors whose path belongs to a control this form renders. */
  readonly matched: readonly MatchedFieldError<TField>[];
  /** Errors whose path does not. **Never dropped** — see below. */
  readonly unmatched: readonly FieldError[];
}

/**
 * Splits the server's field errors into the ones this form can show on a
 * control and the ones it cannot.
 *
 * **The unmatched half is the point of this function.** The tempting
 * implementation maps what it recognises and discards the rest, and the
 * symptom is a form that refuses to submit while displaying no error at all —
 * the server said `organizationSlug` is taken, the form has no such input, and
 * the user is left pressing a button that does nothing. `forms.md` §1 rule 3
 * puts field errors on fields; the corollary is that everything else has to
 * surface somewhere, and {@link formLevelMessage} is where.
 *
 * Only the FIRST error per field is kept: a control shows one message, and
 * later ones would be silently invisible anyway. Any subsequent error for a
 * field already matched is not discarded — it moves to `unmatched`.
 */
export function distributeFieldErrors<TField extends string>(
  fieldErrors: readonly FieldError[],
  knownFields: readonly TField[],
): DistributedFieldErrors<TField> {
  const known = new Set<string>(knownFields);
  const matched: MatchedFieldError<TField>[] = [];
  const unmatched: FieldError[] = [];
  const claimed = new Set<string>();

  for (const fieldError of fieldErrors) {
    const candidate = known.has(fieldError.path)
      ? fieldError.path
      : known.has(rootSegment(fieldError.path))
        ? rootSegment(fieldError.path)
        : null;

    if (candidate === null || claimed.has(candidate)) {
      unmatched.push(fieldError);
      continue;
    }
    claimed.add(candidate);
    matched.push({ field: candidate as TField, message: fieldError.message });
  }

  return { matched, unmatched };
}

/**
 * What the form-level error region says.
 *
 * The server's own `message` first, then any unmatched field error appended
 * with its path, so a validation failure about something this form does not
 * render is still readable rather than merely non-blank. The request ID is
 * rendered separately by the error region (`architecture/frontend.md` §6) and
 * is deliberately not concatenated in here.
 */
export function formLevelMessage(error: ApiError, unmatched: readonly FieldError[]): string {
  if (unmatched.length === 0) return error.message;
  const detail = unmatched.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
  return `${error.message} (${detail})`;
}

export interface ServerFormErrors<TField extends string> {
  readonly fieldErrors: readonly MatchedFieldError<TField>[];
  readonly formMessage: string;
  readonly requestId: string | null;
}

/**
 * The whole mapping in one call: what goes on each control, what goes in the
 * form-level region, and the request ID that region has to show.
 *
 * A non-{@link ApiError} rejection is still surfaced rather than swallowed —
 * an unexpected throw inside a submit handler is exactly the failure a blank
 * error region hides.
 */
export function serverFormErrors<TField extends string>(
  error: unknown,
  knownFields: readonly TField[],
): ServerFormErrors<TField> {
  if (!(error instanceof ApiError)) {
    return {
      fieldErrors: [],
      formMessage: 'Something went wrong. Try again.',
      requestId: null,
    };
  }
  const { matched, unmatched } = distributeFieldErrors(error.fieldErrors, knownFields);
  return {
    fieldErrors: matched,
    formMessage: formLevelMessage(error, unmatched),
    requestId: error.requestId,
  };
}
