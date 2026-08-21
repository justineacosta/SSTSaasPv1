/**
 * Joins class name fragments, dropping anything falsy. No specificity
 * merging (no tailwind-merge): appending a caller's `className` last in the
 * output *string* does not make it win. Two Tailwind utilities of equal
 * specificity are resolved by their order in the compiled stylesheet, which
 * the string's order has no influence over — a caller writing
 * `<Button className="bg-[var(--color-danger)]">` to override the variant's
 * own background may see no effect at all. Reach for `tailwind-merge` if
 * that turns out to matter in practice.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter((value): value is string => Boolean(value)).join(' ');
}
