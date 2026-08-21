import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)]',
      'bg-[var(--color-surface)] px-3 text-[length:var(--text-body)] text-[var(--color-text)]',
      'placeholder:text-[var(--color-text-subtle)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-invalid:border-[var(--color-danger)]',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
