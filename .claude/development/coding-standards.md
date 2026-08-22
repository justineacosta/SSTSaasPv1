# Coding standards

> **Status: Defined. Enforcement lands in Phase 1** (ESLint, Prettier, tsconfig, CI).

Rules here are enforced by tooling wherever possible. A convention that depends on reviewer
memory is a convention that erodes.

## 1. TypeScript

`strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
`exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`.

- **No `any`.** Use `unknown` and narrow. Where `any` is genuinely unavoidable, it carries an
  `// eslint-disable-next-line` with a written justification; CI reports the count and it must
  not grow.
- **No non-null assertion (`!`)** except immediately after a check the compiler cannot see, with
  a comment saying why.
- **No type assertions to silence errors.** An assertion is a claim; if you cannot justify the
  claim, the type is wrong.
- **Infer types from Zod schemas.** `type CreateScan = z.infer<typeof createScanSchema>` — never
  a hand-written interface alongside a schema, because the two will drift and the drift will be
  silent.
- Discriminated unions over optional-field soup. Model impossible states out of existence.
- `readonly` for anything not intended to mutate. `const` by default.

## 2. Naming

The domain vocabulary is fixed and does not vary: **asset, scope, scan, finding, occurrence,
evidence, retest, engagement, report, organisation**. Not "issue", not "vulnerability", not
"target" where "asset" is meant. Inconsistent naming between the database, the API, and the UI
is how a codebase becomes hard to search.

Files `kebab-case.ts`; React components `PascalCase.tsx`. Types and components `PascalCase`;
functions and variables `camelCase`; constants `SCREAMING_SNAKE_CASE`; booleans read as
predicates (`isVerified`, `hasEvidence`, `canCancel`). Database columns `camelCase` via Prisma;
enums `SCREAMING_SNAKE_CASE`.

## 3. Structure

Functions do one thing and are named for it. A function needing a comment to explain *what* it
does wants a better name; a comment explaining *why* is valuable and should stay.

Early returns over nested conditionals. Guard clauses first. Prefer pure functions for anything
testable — the domain layer should be testable without a database or an HTTP request, and where
that becomes hard, the layering has slipped.

Files stay under ~300 lines; a longer file usually holds two things. Related code lives
together by feature, not by technical type — `modules/findings/` contains its controller,
service, repository, DTOs, and tests, rather than scattering them across four global folders.

## 4. Comments

Comment the *why*, never the *what*. Every non-obvious security decision gets a comment
explaining the threat it addresses — the next person to touch scope evaluation needs to know
which lines are load-bearing.

`TODO` requires an issue reference. A `TODO` without one is deleted, because an unreferenced
TODO is a note to nobody.

## 5. Error handling

Typed domain exceptions, mapped centrally to status codes
([`../api/errors.md`](../api/errors.md)). Never throw a bare `Error` from domain code. Never
swallow an exception silently — if it is genuinely ignorable, say so in a comment.

`async`/`await` throughout; no floating promises (lint-enforced). Every `await` in a request
path has a considered failure behaviour.

## 6. Security rules enforced by lint

These have ESLint rules, not just good intentions:

- No `process.env` outside `packages/config`.
- No import of the unscoped Prisma client outside migrations, seeds, and platform admin. This
  covers both the `unscoped` module and the generated client path it wraps
  (`packages/db/generated/client`) — fencing only the former left the direct import clean, which
  a Task 14 review demonstrated with a probe file.
- No `dangerouslySetInnerHTML` outside the reviewed markdown renderer.
- No raw hex colours in `packages/ui` or `apps/web` components — reference a design token
  custom property instead (Task 12). Arbitrary spacing values are not yet lint-enforced.
- No `alert()`, `confirm()`, or `prompt()`.
- No string concatenation into a SQL template.
- No `console.log` — use the structured logger.
- Import boundaries between modules, per [`../architecture/backend.md`](../architecture/backend.md) §1.

## 7. Database access

Always through the tenant-scoped client. Every repository method takes a `TenantContext`.
`select` and `include` are explicit — never fetch a whole model to read one column, and never
rely on Prisma's default field set, which changes when the schema changes.

**On tenant-owned models, write the scalar foreign key directly** — `organizationId: orgId`
in a `create`/`upsert` payload — **never Prisma's relation-connect form**
(`organization: { connect: { id: orgId } }`). The tenant-scoped client
(`packages/db/src/tenant-client.ts`) forces the scalar column into `data` for exactly these
operations; a `connect`-shaped payload has no `organizationId` key for it to force, and fails
with "Unknown argument `organizationId`". This is a deliberate scope decision, not an
oversight to file a bug about: teaching the extension to normalise `connect`/`connectOrCreate`
shapes would add meaningfully more surface to a file that has already produced four Critical
tenant-isolation review findings, and it stays small and auditable instead.

Multi-write operations run in a transaction, with the audit event inside it and side effects
(queue, email, webhook, realtime) **after commit**.

## 8. React

Server components by default; `'use client'` only where interactivity requires it. Domain
components receive data and callbacks and never fetch. Effects are a last resort — most
`useEffect` calls in this codebase would be better as derived state or a query.

Every list has stable keys that are not array indices. Every form uses React Hook Form with the
shared Zod schema. Every interactive element is keyboard-operable and has an accessible name.

## 9. Git

Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`,
`security:`). Small, focused commits with a body explaining *why* when the change is not
obvious. Branches `feat/`, `fix/`, `security/`, `chore/`. Never commit directly to `main`.
Never commit a `.env`, a credential, or a real customer value.
