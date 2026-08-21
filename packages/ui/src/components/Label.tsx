import { forwardRef, type LabelHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export const Label = forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      'block text-[length:var(--text-sm)] leading-[var(--leading-sm)] font-medium text-[var(--color-text)]',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
