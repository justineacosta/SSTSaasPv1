import { cloneElement, forwardRef, useId, type HTMLAttributes, type ReactElement } from 'react';
import { cn } from '../cn.js';
import { Label } from './Label.js';

interface ControllableProps {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string;
  description?: string;
  error?: string;
  /** The form control. Wired to the label and to the description/error via aria-describedby. */
  children: ReactElement<ControllableProps>;
}

/**
 * Wires a label, a control, an optional description, and an optional error
 * together with `aria-describedby` and `aria-invalid`. A form error not
 * programmatically tied to its input is invisible to a screen reader, which
 * is why this is a component rather than a convention.
 */
export const Field = forwardRef<HTMLDivElement, FieldProps>(
  ({ label, description, error, children, className, ...rest }, ref) => {
    const generatedId = useId();
    const controlId = children.props.id ?? generatedId;
    const descriptionId = description ? `${controlId}-description` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;

    // Merge with whatever the child already declares. cloneElement replaces
    // a prop outright rather than adding to it, so overwriting
    // aria-describedby here would silently strip an association the caller
    // already set up on their own control.
    const describedBy =
      [children.props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ') ||
      undefined;

    const overrides: Partial<ControllableProps> = {
      id: controlId,
      'aria-describedby': describedBy,
    };
    // Only set aria-invalid when there's an error to report. cloneElement
    // with an explicit `undefined` overwrites — it does not "leave alone" —
    // whatever the child already had, so a control's own aria-invalid has to
    // be left out of `overrides` entirely rather than cleared to undefined
    // here.
    if (error) {
      overrides['aria-invalid'] = true;
    }

    const control = cloneElement(children, overrides);

    return (
      <div ref={ref} className={cn('flex flex-col gap-1.5', className)} {...rest}>
        <Label htmlFor={controlId}>{label}</Label>
        {control}
        {description ? (
          <p
            id={descriptionId}
            className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]"
          >
            {description}
          </p>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-danger)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';
