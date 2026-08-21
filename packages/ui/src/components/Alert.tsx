import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
}

const variantClasses: Record<AlertVariant, string> = {
  info: 'border-[var(--color-border-strong)] text-[var(--color-text)]',
  success: 'border-[var(--color-success)] text-[var(--color-success)]',
  warning: 'border-[var(--color-warning)] text-[var(--color-warning)]',
  danger: 'border-[var(--color-danger)] text-[var(--color-danger)]',
};

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'info', role, ...props }, ref) => {
    // 'alert' is the assertive live-region role — announced immediately,
    // interrupting other speech. That's appropriate for `danger` (a failure,
    // something the user needs to hear now) but not for the other variants,
    // which should announce politely like any other status update. An
    // explicit `role` prop always wins.
    const resolvedRole = role ?? (variant === 'danger' ? 'alert' : 'status');
    return (
      <div
        ref={ref}
        role={resolvedRole}
        className={cn(
          'flex items-start gap-2 rounded-[var(--radius-control)] border bg-[var(--color-surface-raised)]',
          'px-3 py-2 text-[length:var(--text-sm)] leading-[var(--leading-sm)]',
          variantClasses[variant],
          className,
        )}
        {...props}
      />
    );
  },
);
Alert.displayName = 'Alert';
