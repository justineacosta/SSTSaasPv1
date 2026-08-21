import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type BadgeVariant = 'neutral' | 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  neutral:
    'border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]',
  critical:
    'border-transparent bg-[var(--color-severity-critical-surface)] text-[var(--color-severity-critical)]',
  high: 'border-transparent bg-[var(--color-severity-high-surface)] text-[var(--color-severity-high)]',
  medium:
    'border-transparent bg-[var(--color-severity-medium-surface)] text-[var(--color-severity-medium)]',
  low: 'border-transparent bg-[var(--color-severity-low-surface)] text-[var(--color-severity-low)]',
  info: 'border-transparent bg-[var(--color-severity-info-surface)] text-[var(--color-severity-info)]',
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'neutral', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-0.5',
        'text-[length:var(--text-caption)] font-medium',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  ),
);
Badge.displayName = 'Badge';
