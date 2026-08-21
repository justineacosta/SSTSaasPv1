import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]',
      className,
    )}
    {...props}
  />
));
Card.displayName = 'Card';
