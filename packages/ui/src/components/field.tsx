import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
} from 'react';
import { cn } from '../cn.js';
import { Label } from './label.js';

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
    const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

    const control = isValidElement<ControllableProps>(children)
      ? cloneElement(children, {
          id: controlId,
          'aria-describedby': describedBy,
          'aria-invalid': error ? true : undefined,
        })
      : children;

    return (
      <div ref={ref} className={cn('flex flex-col gap-1.5', className)} {...rest}>
        <Label htmlFor={controlId}>{label}</Label>
        {control}
        {description ? (
          <p
            id={descriptionId}
            className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
          >
            {description}
          </p>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-[length:var(--text-caption)] text-[var(--color-danger)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';
