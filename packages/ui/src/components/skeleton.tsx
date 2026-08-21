import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/**
 * A loading placeholder matching the shape of the content it stands in for.
 * `animate-pulse` is neutralised by tokens.css's `prefers-reduced-motion`
 * rule. Not to be confused with the product's one ambient, SSE-driven
 * scan-progress animation (design-system.md §6) — this pulses only while
 * its own content is loading, never as a claim about scan state.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-raised)]',
        className,
      )}
      {...props}
    />
  ),
);
Skeleton.displayName = 'Skeleton';
