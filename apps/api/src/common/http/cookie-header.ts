/**
 * READING THE `Cookie` HEADER — THE FIRST PARSER OF ONE IN THIS CODEBASE.
 *
 * Task 6's carry-forward ruling 54 records why there was none. `cookies.ts` in
 * the auth module owns the session cookie's name and attributes on the way
 * *out*; Task 6 issued credentials and deliberately never inspected one, so the
 * parsing side waited for the guard that needs it.
 *
 * It lives in `common/` rather than beside `cookies.ts` because two guards need
 * it — authentication and CSRF — and only one of them is in the auth module.
 * Nothing here knows the name of any particular cookie: the session cookie's
 * name is `cookies.ts`'s, and the caller passes it in.
 *
 * **Hand-written rather than the `cookie` package**, which is two behaviours
 * this file deliberately does not want: it percent-decodes (see below), and it
 * resolves a duplicated name by keeping one of them. Neither is configurable,
 * and both sit directly on the path that decides which credential a request
 * carries. The whole parser is thirty lines.
 *
 * **The input is a header an attacker writes in full.** Every rule below is
 * chosen for what it does to a hostile header, not for what it does to a
 * browser's.
 */

/**
 * The `Cookie` header, as Node presents it.
 *
 * **`readonly string[]` is unreachable today, and the reason first written here
 * was false.** It said Node exposes a repeated header as an array and that a
 * parser typed only for `string` would read `undefined` from it. Measured on
 * Node v26.7.0 over a raw socket, sending each header twice in one request:
 *
 * ```
 * Cookie: a=1 / Cookie: b=2            -> string("a=1; b=2")
 * X-Custom: one / X-Custom: two        -> string("one, two")
 * Set-Cookie: s=1 / Set-Cookie: s=2    -> array(["s=1","s=2"])
 * Authorization: A / Authorization: B  -> string("Bearer first")   <- second DROPPED
 * ```
 *
 * Node special-cases `cookie` and joins repeats with `'; '`; only `set-cookie`
 * is ever an array. So the array branch below cannot fire for this header on
 * this runtime. It is kept as depth rather than deleted — the union costs one
 * `flatMap` and this is a credential decision — but it is described as
 * unreachable-today rather than as a case that occurs.
 *
 * The `Authorization` row is the one that matters for a later task: a repeated
 * `Authorization` does not join and does not arrive as an array — **the second
 * is silently discarded and the first wins**. A header the parser never sees is
 * a worse failure than one it mis-parses, and that is the header the API-key
 * half of this stage will read.
 */
export type CookieHeader = string | readonly string[] | undefined;

/** Names seen once map to their value; a name seen twice is not in the map. */
export function parseCookieHeader(header: CookieHeader): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const duplicated = new Set<string>();
  const segments = (typeof header === 'string' ? [header] : (header ?? [])).flatMap((part) =>
    part.split(';'),
  );

  for (const segment of segments) {
    const separator = segment.indexOf('=');
    // No `=` at all is not a cookie. `=1` has no name. Neither can be addressed
    // by a caller asking for a name, so both are dropped rather than stored
    // under a key nothing will ever ask for.
    if (separator <= 0) continue;

    const name = segment.slice(0, separator).trim();
    if (name === '') continue;

    // `indexOf`, not `split('=')`: base64 padding puts `=` inside the value,
    // and splitting on every `=` would truncate a padded token to its first
    // segment. Only the first `=` separates.
    const value = segment.slice(separator + 1).trim();

    if (values.has(name) || duplicated.has(name)) {
      // TWO COOKIES WITH ONE NAME IS NOT A VALUE TO CHOOSE BETWEEN.
      //
      // First-wins hands the request to whoever can prepend; last-wins, to
      // whoever can append. Dropping the name favours neither, and the request
      // becomes unauthenticated — which is the direction a credential decision
      // has to fail in.
      //
      // The `__Host-` prefix makes this close to unreachable for the session
      // cookie: a browser refuses to store a `__Host-` cookie carrying a
      // `Domain`, so a sibling subdomain cannot place one that is then sent to
      // the API's host. It is handled anyway because "close to unreachable"
      // describes today's deployment, and the rule costs one branch.
      values.delete(name);
      duplicated.add(name);
      continue;
    }
    values.set(name, value);
  }

  return values;
}

/**
 * One named cookie's value, or `undefined` for absent, empty, or ambiguous.
 *
 * **No percent-decoding, deliberately.** `decodeURIComponent('%')` throws a
 * `URIError`, so a parser that decoded would turn an attacker-chosen cookie
 * into a 500 on every request carrying it — reachable by anyone who can get a
 * cookie into a victim's browser, and by anyone at all against their own
 * requests. Nothing this application sets needs decoding: the session token is
 * base64url and the CSRF token is base64url, both already inside RFC 6265's
 * `cookie-octet` set, which `serialiseSessionCookie` asserts on the way out.
 *
 * An **empty** value is `undefined` rather than `''` because that is the cookie
 * the logout response sets (`clearedSessionCookie`). Returning it as a
 * credential would spend a SHA-256, a Redis read and a Postgres read proving
 * what the browser already said.
 */
export function readCookie(header: CookieHeader, name: string): string | undefined {
  const value = parseCookieHeader(header).get(name);
  return value === undefined || value === '' ? undefined : value;
}
