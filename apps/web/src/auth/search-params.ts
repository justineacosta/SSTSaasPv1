/**
 * The first value of a query parameter, or `null`.
 *
 * Next hands a repeated parameter (`?next=/a&next=/b`) through as an array. A
 * caller that expects a string and gets `string[]` would either crash or, worse,
 * stringify it — `"/a,/b"` — and hand that to a validator that was written to
 * think about paths. Collapsing it here means every screen below receives
 * `string | null` and nothing else.
 *
 * Taking the first rather than the last is arbitrary but must be *decided*: an
 * attacker who can append a parameter to a link should not be able to override
 * one that is already there by adding a second.
 */
export function firstParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/** The shape Next passes to a page's `searchParams` prop in the App Router. */
export type SearchParams = Record<string, string | string[] | undefined>;
