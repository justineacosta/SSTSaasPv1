# ADR-0024: The API base URL reaches the browser through a server-rendered provider, not a `NEXT_PUBLIC_` variable

**Status:** Accepted · **Date:** 2026-09-04

## Context

[ADR-0017](ADR-0017-cors-allowlist-with-credentials.md) decided that the browser calls the API
**directly, cross-origin**. Every fetch a page makes therefore needs an absolute origin, and it
needs it in code that runs in the browser. Task 16 is the first task that writes such a fetch:
until now `apps/web` has called nothing.

Three existing constraints bound the answer, and none of them is negotiable in this task:

- **`packages/config` is the only place in this workspace permitted to read `process.env`**,
  enforced by the `no-restricted-properties` rule in `eslint.config.js:50-53`. Every other module
  reaches configuration through a parsed schema.
- **`API_BASE_URL` already exists**, declared on `webEnvSchema` at `packages/config/src/env.ts:428`
  and parsed once at module load by `apps/web/src/env.ts`. It is the same variable
  `apps/api` is constructed with, which is what keeps the CORS allowlist and the origin the page
  calls from drifting apart — ADR-0017 spends a paragraph on exactly that hazard.
- **Next only inlines an environment variable into the client bundle when its name begins
  `NEXT_PUBLIC_`.** A variable named `API_BASE_URL` is a server-side value; a client component
  reading it gets `undefined`.

So the question is not *what* the value is. It is **how a value that is already correct on the
server crosses into the browser bundle**, and the shape of that answer is copied by every client
fetch this product will ever write.

## Decision

**A server component reads `env.API_BASE_URL` and passes it to a client provider as a prop. The
browser never reads an environment variable, and no `NEXT_PUBLIC_` variable is introduced.**

Concretely: the root layout — a server component — renders the client `Providers` tree with
`apiBaseUrl={env.API_BASE_URL}`, and the typed API client reads that value out of React context.
Three properties are part of this decision rather than implementation detail:

- **One variable, one parse, one authority.** `API_BASE_URL` on `webEnvSchema` stays the single
  declaration. There is no second name for the same value, so there is no pair to drift.
- **`packages/config` remains the only reader of `process.env`.** The lint rule keeps holding
  without an exemption, and `apps/web/src/env.ts` stays the one door.
- **The value is a prop, so it is typed and it fails at build time.** A missing
  `NEXT_PUBLIC_` variable is `undefined` at runtime, in the browser, as a fetch to
  `undefined/api/v1/auth/login`. A missing prop is a TypeScript error.

This costs nothing in rendering strategy: `architecture/frontend.md` §2 records that **every HTML
route in this app is already `force-dynamic`**, set once in `apps/web/app/layout.tsx`, because
Next stamps the CSP nonce by reading the policy off the request. There is no prerendered page for
a server-read environment variable to be baked into at build time, so the usual objection to this
pattern does not apply here.

## Alternatives considered

**`NEXT_PUBLIC_API_BASE_URL`.** The idiomatic Next answer, and rejected on the drift it creates.
It is a *second* declaration of a value `webEnvSchema` already owns, which means two variables
that must agree, only one of which is schema-validated — and the unvalidated one is the one the
browser uses. It also needs an eslint exemption or a second reader of `process.env`, which
weakens a rule that currently has exactly three deliberate exceptions. The failure mode is the
part that decides it: when the two disagree, the page calls an origin the API's CORS allowlist
does not contain, and the symptom is a CORS error in the browser console — the error whose
tempting fix is to widen the allowlist, which is the single failure ADR-0017 was written to
prevent.

**Relative URLs plus a Next rewrite or proxy.** Would make every request same-origin and remove
the question entirely. It is ADR-0017's rejected alternative, rejected there on routing
authority, the extra hop on SSE, and the client address disappearing behind a proxy that half the
rate limits are keyed on. Nothing in Task 16 changes that analysis, and re-deciding it here would
supersede ADR-0017 rather than extend it.

**A `/api/config` route on `apps/web` the client fetches at boot.** Rejected: it buys a network
round trip before the first real request, on every page load, to learn a value the server already
knew while rendering. It also creates a loading state on every screen for configuration rather
than for data.

**What would make us switch.** If the product moves to a single origin (ADR-0017's own switching
condition), the base URL becomes the empty string and this ADR is moot rather than wrong. If a
future page must be statically prerendered — which requires the CSP conflict in
`architecture/frontend.md` §2 to be resolved first — a build-time value would be needed for that
route, and this ADR would be superseded rather than edited.

## Consequences

**Positive.** One declaration of the API origin, schema-validated, shared with the value
`apps/api` builds its CORS allowlist from. A missing value is a type error rather than a browser
console error. No new `process.env` reader and no lint exemption.

**Negative.** The API client cannot be a bare module-scope singleton — it has to be reached
through context, so every consumer is a client component under the provider, and a non-React
caller (a plain utility, a test helper) has to be handed the base URL explicitly rather than
importing it. This is a real ergonomic cost and it is paid on every call site.

**Neutral.** The provider is one more prop threaded through the root layout. It also establishes
the shape for the next server-known value the browser needs, which is a convention being set
here whether or not it is noticed later.
