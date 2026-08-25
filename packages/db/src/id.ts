import { uuidv7obj } from 'uuidv7';

/**
 * Entity prefixes. IDs are opaque to clients (api/conventions.md §1) but
 * self-describing in a log line, which is worth a great deal when correlating
 * an incident across the API, a queue payload, and a worker.
 *
 * `fnd` (finding) and `scn` (scan) are registered ahead of the models that
 * will use them (Phase 2+) so downstream packages can reference the full
 * entity vocabulary from Phase 1 without a breaking rename later.
 *
 * THIS LIST HAS A TWIN: `ID_SCHEMA_PREFIXES` in `@sentinel/contracts`, which is
 * what the API *validates* against. Through Phase 1 the two were independent,
 * nothing compared them, and they drifted. `id-prefix-parity.spec.ts` now fails
 * when either side gains a prefix the other does not know about — so adding a
 * prefix here means adding a schema there, or adding an explicit reason to that
 * spec's `DB_ONLY_PREFIXES` allowlist saying why the client never sees it.
 *
 * Every prefix is exactly three characters because `parseIdPrefix` below
 * matches `[a-z]{3}`. That constraint is why the Phase 2 addition for
 * `IdentityProviderLink` is `idp` and not `idpl`.
 */
export const ID_PREFIXES = {
  org: 'org',
  usr: 'usr',
  mbr: 'mbr',
  ses: 'ses',
  crd: 'crd',
  rol: 'rol',
  prm: 'prm',
  inv: 'inv',
  aud: 'aud',
  req: 'req',
  fnd: 'fnd',
  scn: 'scn',
  // Phase 2 identity models (Task 1's schema, Task 2's prefixes).
  mfa: 'mfa',
  vtk: 'vtk',
  rcv: 'rcv',
  idp: 'idp',
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

/** Crockford base32 — excludes I, L, O, and U to avoid transcription errors. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_BODY_LENGTH = 26;

function encodeCrockford(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  for (let index = 0; index < ID_BODY_LENGTH; index += 1) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/**
 * Generates a prefixed UUIDv7 identifier, e.g. `org_01M0T74WZZFY9T2QS56RGF3GQ7`.
 *
 * That example is a real `newId('org')` output, and `id.spec.ts` asserts that
 * every backticked example in this file parses. The previous one did not: its
 * body was 25 characters where ID_BODY_LENGTH is 26, and it contained U, I and
 * O — three of the four letters the Crockford alphabet above deliberately
 * excludes. `parseIdPrefix()` returned undefined for this file's own example.
 * An illustrative-looking string is exactly the kind that nobody checks, so the
 * test is what stops it coming back rather than this paragraph.
 *
 * UUIDv7 is time-ordered, so index locality is good on the leading edge of
 * every table — which matters because every hot query in this product sorts by
 * recency. Base32 keeps it URL-safe and case-insensitive to read aloud.
 *
 * See ADR-0011.
 */
export function newId(prefix: IdPrefix): string {
  return `${ID_PREFIXES[prefix]}_${encodeCrockford(uuidv7obj().bytes)}`;
}

const ID_PATTERN = new RegExp(`^([a-z]{3})_[${ALPHABET}]{${ID_BODY_LENGTH}}$`);

export function parseIdPrefix(id: string): IdPrefix | undefined {
  const match = ID_PATTERN.exec(id);
  const candidate = match?.[1];
  if (candidate === undefined) return undefined;
  return candidate in ID_PREFIXES ? (candidate as IdPrefix) : undefined;
}
