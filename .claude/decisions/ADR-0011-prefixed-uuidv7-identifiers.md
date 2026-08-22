# ADR-0011 — Prefixed UUIDv7 identifiers, generated in application code

**Status:** Accepted · **Date:** 2026-08-22

## Context

Two Phase 0 documents pull in different directions.

[`../architecture/database.md`](../architecture/database.md) §1 wants **UUIDv7** primary keys for
index locality: every hot query in this product sorts by recency, so a time-ordered key keeps
inserts and the common range scans on the leading edge of the index.

[`../api/conventions.md`](../api/conventions.md) §1 wants **opaque prefixed strings** that clients
must not parse (`fnd_01J…`), and states that the organisation never appears in a URL. An ID is
therefore something a client copies around and hands back, not something it takes apart.

Those are not the same requirement. The first is about storage layout, the second about the wire
format and about what an ID reveals in a log line. A single decision has to satisfy both, and it
has to be made once because primary keys are the single hardest thing in a schema to change
later.

## Decision

**UUIDv7, generated in application code, encoded to 26-character Crockford base32, with a
three-letter entity prefix and an underscore separator.**

- Implementation: `packages/db/src/id.ts` — `newId(prefix)` and `parseIdPrefix(id)`.
- UUIDv7 comes from the `uuidv7` package (`uuidv7obj().bytes`); the 16 raw bytes are encoded
  most-significant-first into the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`,
  which excludes `I`, `L`, `O` and `U` so an ID read aloud or copied by hand does not transcribe
  into a different one.
- The body is fixed at **26 characters**; with a three-letter prefix and the separator, a full
  identifier is **30 characters**. A real one, generated on 2026-08-22:
  `org_01M0MT16GREE3SRQPT837ZZJYN`.
- Prefixes are a closed set in `ID_PREFIXES`: `org`, `usr`, `mbr`, `ses`, `crd`, `rol`, `prm`,
  `inv`, `aud`, `req`, `fnd`, `scn`. `fnd` and `scn` are registered ahead of the models that will
  use them so downstream packages can reference the whole vocabulary without a breaking rename.
- Every primary key in `packages/db/prisma/schema.prisma` is declared `String @id` with **no
  `@default`**, and lands in Postgres as `"id" TEXT NOT NULL`. There is no database-side
  generator to fall back on: if application code does not supply an ID, the insert fails.

## Alternatives considered

**Auto-increment integers.** Rejected. They are enumerable, and they leak business volume to
anyone who can sign up twice and subtract. They also make it trivial to accidentally address
another tenant's row by typing a nearby number — a mistake that should not even be expressible.

**UUIDv4.** Rejected. Random keys land every insert in a different index page, so write
amplification and index bloat climb with table size. For tables that will hold findings and audit
events this is the wrong default to have chosen at the start.

**Bare UUIDv7, no prefix.** Rejected on operability. A UUID in a log line carries no information
about what kind of thing it names, so correlating an incident across the API, a queue payload and
a worker means guessing. The prefix costs four characters and removes the guessing.

**Database-generated IDs.** Rejected. It forces a round trip before the application knows the ID
it just created, which is awkward inside a transaction that then needs to write related rows, and
worse for multi-row inserts. Generating in application code also means an ID exists before the
write, so it can be logged even when the write fails.

**Hex or standard UUID string form.** Rejected. 36 characters with hyphens, not URL-friendly
without escaping in every context, and case-sensitive to read back. Crockford base32 is shorter,
URL-safe and forgiving of transcription.

## Consequences

**Positive.** Index locality of UUIDv7 without giving up opacity. IDs are self-describing in
logs, queues and support tickets. `parseIdPrefix` gives a cheap sanity check at a boundary — a
`usr_` where a `fnd_` belongs is caught before it reaches the database. IDs are URL-safe with no
escaping.

**Negative — the honest costs.**

- **30 bytes per key rather than 16.** Every foreign key pays that too, on every index. On a
  findings table this is real, not theoretical.
- **`TEXT` primary keys rather than `UUID`.** Postgres cannot use its native UUID comparison; it
  compares strings. That costs a little index size and a little comparison speed, and buys the
  prefix.
- **The prefix is not enforced by the database.** Nothing stops an `org_` ID being written into
  a column that should hold `usr_`. `parseIdPrefix` is available but is not a constraint, and
  making it one (a `CHECK`) has not been done.
- **The illustrative IDs in the Phase 0 documents are not real IDs, and are deliberately left
  alone.** The one non-elided example, `req_01J8XK2P9V3QWERTY` in
  [`../api/errors.md`](../api/errors.md) §1, has a **17-character body** where a real one has 26.
  Everywhere else the documents write `org_01J…` with an ellipsis. These were abbreviated for
  readability and are **illustrations, not specifications**; the documents are not edited to
  match, because rewriting an example into a 30-character string makes the surrounding JSON
  harder to read for no gain. If an example ever needs to be exact, it must be generated by
  `newId`, not typed.
- **The example in `id.ts`'s own docstring is likewise not a valid ID** — it is 25 characters and
  contains `U`, `I` and `O`, which the Crockford alphabet excludes, so `parseIdPrefix` returns
  `undefined` for it. It is a docstring illustration with the same status as the ones above.

**Neutral.** Changing the encoding later is a data migration across every table and every
foreign key — which is the reason this is an ADR rather than a comment. The prefix set can grow
without a migration; removing or renaming one cannot.
