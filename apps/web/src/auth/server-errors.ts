import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { serverFormErrors } from '../api/field-errors';

export interface FormFailure {
  /** What the form-level error region says. Never empty. */
  readonly message: string;
  /** For support. `null` when the server never answered. */
  readonly requestId: string | null;
}

/**
 * Puts a failed submission's server errors where a user can act on them.
 *
 * Field errors go on their controls via React Hook Form's `setError`, which is
 * what `Field` turns into `aria-invalid` and an `aria-describedby` error node.
 * The **first** one focuses its control, because `accessibility.md` §4 requires
 * focus to move to the first invalid field on a failed submission — otherwise a
 * screen reader user is told something is wrong and left at the submit button.
 *
 * Everything that did not map onto a control comes back in the returned
 * message, so an error about a field this form does not render is still
 * readable. `forms.md` §1 rule 2 is the other half: the caller never resets the
 * form, so the user's input survives the failure.
 */
export function applyServerErrors<TValues extends FieldValues>(
  error: unknown,
  fields: readonly Path<TValues>[],
  setError: UseFormSetError<TValues>,
): FormFailure {
  const mapped = serverFormErrors(error, fields as readonly string[]);

  mapped.fieldErrors.forEach((fieldError, index) => {
    setError(
      fieldError.field as Path<TValues>,
      { type: 'server', message: fieldError.message },
      { shouldFocus: index === 0 },
    );
  });

  return { message: mapped.formMessage, requestId: mapped.requestId };
}

/**
 * The same mapping for a failure with no form behind it — a request the screen
 * issued itself, such as `/verify-email` submitting on load. There is no
 * control for a field error to land on, so everything surfaces in the
 * form-level region and, again, nothing is dropped.
 */
export function toFormFailure(error: unknown): FormFailure {
  const mapped = serverFormErrors(error, []);
  return { message: mapped.formMessage, requestId: mapped.requestId };
}
