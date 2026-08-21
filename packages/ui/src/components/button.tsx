import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** True while the action this button starts is in flight. Disables the button. */
  pending?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-[var(--color-accent)] text-[var(--color-surface)] hover:opacity-90',
  secondary:
    'border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]',
  ghost:
    'border border-transparent bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-raised)]',
  danger:
    'border border-transparent bg-[var(--color-danger)] text-[var(--color-surface)] hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-[var(--row-height-dense)] px-3 text-[length:var(--text-sm)]',
  md: 'h-[var(--row-height-compact)] px-4 text-[length:var(--text-body)]',
};

/**
 * Buttons name the outcome: "Start scan", "Generate report", "Revoke key" —
 * never "Submit", "OK", or "Confirm". The verb stays constant through the
 * flow, so the button that says "Start scan" produces a toast that says
 * "Scan started". See ui-ux/design-system.md §8.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      pending = false,
      disabled,
      type = 'button',
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium',
        'transition-[background-color,opacity] duration-[var(--duration-hover)] ease-[var(--ease-standard)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
