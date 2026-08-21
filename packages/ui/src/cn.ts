/**
 * Joins class name fragments, dropping anything falsy. No specificity
 * merging (no tailwind-merge): callers append their own `className` last,
 * so an override wins by CSS source order the same way it would with plain
 * Tailwind classes anywhere else in the app.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(' ');
}
