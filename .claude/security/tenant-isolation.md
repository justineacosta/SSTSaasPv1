# Tenant isolation

> **Status: Partially Implemented.** Layer 1 (the mandatory scoped client) is implemented for
> top-level operations only — it has no visibility into relations, by design; see
> `packages/db/src/tenant-client.ts`'s file-level comment. Layer 2 (RLS) is implemented and,
> as of Task 6's review round, verified to run *together* with layer 1 through
> `withTenantTransaction` — `packages/db/src/tenant-transaction.integration.spec.ts` is the
> proof, including that RLS alone (not layer 1) is what catches nested reads and nested writes
> reaching a tenant-owned model through a relation. Not yet wired into a request pipeline —
> that is Phase 2, once there are tenant-owned routes to wire it into. Layer 3 (response DTOs)
> is Not Implemented — there are no handlers yet to serialise. §3 (isolation beyond the REST
> API) and §4 (the generated cross-resource test matrix) remain Designed, Not Implemented until
> Phase 2+ adds the resources they cover.

Tenant isolation is the control most likely to fail, because it fails silently. A missing
`where` clause produces working code, passing tests, and a data breach. The design assumes
someone will forget, and makes forgetting non-fatal.

## 1. Tenant boundary

The **Organization** is the tenant. Every tenant-owned row carries `organizationId`
directly — not through a join — so that isolation is a single predicate on every table.
`User` is the one global entity; `Membership` binds a user into a tenant.

`Organization` itself is the **tenant root**: it has no `organizationId` column (it *is*
the tenant), so it is scoped by `id` instead, everywhere the resource registry scopes
tenant-owned models by `organizationId` — both layers below, and the tenant resource
registry (`packages/db/src/tenant-resources.ts`'s `TENANT_ROOT_MODEL`), treat it as a
distinct concept from `TENANT_OWNED_MODELS` rather than folding it in. `Organization`
also has `DELETE` revoked from the application role outright: deleting a tenant is a
platform-admin operation (Phase 11), not something request-path code can do at all.

## 2. Three layers

### Layer 1 — Mandatory scoping in the data client (primary)

Handlers never receive a raw Prisma client. They receive one bound to the request's
organisation by a Prisma client extension (`packages/db/src/tenant-scope.ts`'s pure
decision logic, wrapped by `packages/db/src/tenant-client.ts`) that, for every
tenant-owned model and the tenant root, and only at the **top level** — see the caveat
below:

- injects the scope predicate (`organizationId`, or `id` for the tenant root) into
  `where` for `findMany`, `findFirst`, `count`, `aggregate`, `groupBy`, `deleteMany`,
  `updateMany`;
- injects it into `data` for `create`, `createMany`, and the `update`/`data` half of
  `update`/`upsert`, so a caller cannot re-parent a row it owns to another tenant by
  setting the scope column directly;
- for `delete`, singular `update`, and `upsert` — which require a flat unique field, not
  an arbitrary filter — forces the same predicate but **refuses outright** rather than
  attempting an invalid query shape if the caller's own filter already names a different
  tenant on that exact field (this is what stops "delete org B" from being silently
  redirected into "delete my own org");
- for `findUnique`/`findUniqueOrThrow`, runs the query **unmodified** — a rewrite to
  `findFirst` was tried and rejected: `findFirst` runs through a *different* client
  method call, which cannot be guaranteed to land on the same database
  connection/transaction as the original call, silently breaking read-your-own-writes and
  RLS's per-transaction GUC together — then checks the scope column on the result before
  deciding what the caller sees. If the caller's `select` doesn't ask for the scope
  column, or its `omit` excludes it, the projection is temporarily widened so the check
  has something to read, and the extra column is stripped back out of the result — a
  narrow projection cannot make an owned row look like it belongs to nobody, and cannot
  become a second way to bypass the check the way the original where-injection design
  could have;
- for `findUniqueOrThrow`, a cross-tenant row raises Prisma's own `PrismaClientKnownRequestError`
  (code `P2025`, "No `<Model>` found") rather than a distinguishable error — a caller
  catching P2025 to mean "not found" must see the same failure whether the row genuinely
  doesn't exist or simply belongs to another tenant, or the *shape of the error itself*
  becomes an oracle confirming another tenant's row exists;
- **throws** if no organisation is present in context.

**Caveat, by design, not a bug**: this only scopes the *top-level* operation. Prisma's
extension hook fires once per top-level call and has no visibility into the nested
operations generated for relations — a nested `include`, or a nested write under
`data.someRelation.create/update/updateMany/deleteMany` — **or into referential-integrity
cascades**, which execute inside Postgres's own constraint machinery and are not SQL the
client ever issues at all (a `User` deleted through `user.delete()` cascading into
`Membership` rows the extension never sees `Membership.delete` for). There is no supported
way to intercept either from a client extension. This is exactly the class of case layer 2
exists to catch — see below. **Layer 2 does not run at all** for migrations, seeds, and the
platform-admin module (they use the unscoped client outside `withTenantTransaction`, by
design — see the ESLint exemption below): those code paths carry no defence-in-depth and
must get isolation right on their own, reviewed accordingly.

The unscoped client lives in one module. An ESLint rule forbids importing it outside
`packages/db/migrations`, seeds, and the platform-admin module, and CI fails on violation.

The rule fences **two** specifiers, and it took a review to notice the second was missing: the
`unscoped` wrapper module, *and* the generated Prisma client path it wraps
(`packages/db/generated/client`). Fencing only the wrapper left
`import { PrismaClient } from '../generated/client/index.js'` linting clean from any file — a
non-exempt probe proved it — which meant this paragraph, and
[`../development/coding-standards.md`](../development/coding-standards.md) §6, described a
control that did not cover the shorter road to the same object. Both specifiers are now in the
restricted group; the only exemptions on the generated path are `unscoped.ts` itself and
`datamodel.ts`, which reads schema metadata and can issue no query.

### Layer 2 — PostgreSQL Row-Level Security (defence in depth)

RLS is enabled and **forced** on every tenant table and on the tenant root, with a policy
on `current_setting('app.organization_id', true)`, set per transaction by
`withTenantTransaction` (`SET LOCAL`, not session-level `SET`, so a pooled connection
cannot inherit one request's tenant into the next). The application role is not
`BYPASSRLS`.

`withTenantTransaction` extends the client with layer 1 *before* opening the transaction,
not after — Prisma's documented behaviour is that an interactive transaction started from
an extended client yields extended `tx` clients, so both layers are live for every
operation inside it. Getting this ordering backwards is a real failure mode, not a
theoretical one: it shipped once during Task 6, silently leaving every caller of
`withTenantTransaction` protected by layer 2 alone. See
`packages/db/src/tenant-transaction.integration.spec.ts`, and its `tenant-transaction.ts`
file-level comment, for the fix and the regression test.

This catches what layer 1 cannot, most importantly relation traversal and
referential-integrity cascades (the caveat above): hand-written SQL, raw queries for
optimised analytics, future ORM changes, and mistakes in the extension itself. Two
independent mechanisms must both be wrong for a leak to occur — proven together, not just
individually, by `tenant-transaction.integration.spec.ts`'s nested-read and nested-write
cases. RI cascades are a **third** category layer 2 cannot catch either — they run inside
Postgres's constraint machinery, below RLS. The rule this drives, checked against
`pg_constraint` directly rather than assumed: **no FK into a tenant-owned table from a
non-tenant-scoped parent is `CASCADE`** (`Membership.userId` was the one violation, found
live in review and fixed to `RESTRICT`). `Membership.organizationId` and
`Invitation.organizationId` *are* `CASCADE` — that's fine, not an exception to track:
both originate at `Organization`, the tenant root itself, so the cascade can only ever
stay inside the one tenant being deleted, layer 1 already scopes `organization.delete` to
the caller's own `id`, and `sentinel_app` holds no `DELETE` on `Organization` at all — see
`packages/db/prisma/schema.prisma`'s relation comments for the reasoning per FK.

That rule is now **mechanically enforced**, not just written down. `pnpm check:registry`
(`scripts/check-tenant-registry.ts`, a required step in `.github/workflows/ci.yml`) reads
`onDelete` from the Prisma DMMF and fails the build on any `Cascade` into a tenant-owned
table from a non-tenant-scoped parent. It carries the qualifier: a cascade whose parent is
`TENANT_ROOT_MODEL` passes, so `Membership.organizationId` and `Invitation.organizationId`
are not exceptions the check has to be told about — they are simply not violations. This
paragraph said the unqualified version once, and it was wrong; the check is the reason the
next person cannot re-introduce either the wrong constraint or the wrong sentence. It also
fails on a foreign key that omits `onDelete` entirely, because Prisma does not put its
default in the DMMF and the default it would apply depends on field optionality — there is
nothing there for a check to read, and guessing in this specific place is guessing about
the one failure mode neither isolation layer can see.

### Layer 3 — Response serialisation

Responses are built from explicit DTOs, never from raw Prisma models. A relation
accidentally included cannot leak, because the serialiser only emits declared fields. This
also prevents the subtler leak of internal fields — fingerprints, storage keys, internal
IDs of other tenants' referenced rows.

## 3. Isolation beyond the REST API

The REST API is the obvious surface and the one people remember to protect. These are the
ones that get missed:

| Surface | Risk | Control |
|---|---|---|
| **SSE / realtime** | Subscribing to another org's event stream | Connection is bound to an authenticated tenant at handshake; the fan-out filters by that tenant *and* by per-event permission before writing |
| **Object storage** | Guessing an evidence key | Keys prefixed `org/{organizationId}/`; buckets never public; every presign re-authorises server-side; presigned URLs short-lived and single-purpose |
| **Background jobs** | A job executing with the wrong tenant | Workers re-resolve the tenant from the database by resource ID and ignore the payload's claims |
| **Search** | Full-text results crossing tenants | Tenant predicate is applied inside the query, never as a post-filter on results |
| **Reports** | A report embedding another tenant's data | Generation runs under the same tenant-scoped client; download re-authorises |
| **Webhooks** | Delivering org A's event to org B's endpoint | Endpoint and event are matched on `organizationId` at dispatch |
| **Notifications** | Cross-tenant notification | Recipient membership verified at creation and at read |
| **Aggregates / dashboard** | A `COUNT(*)` without a tenant predicate | All analytics go through the scoped client or an RLS-covered raw query; reviewed explicitly |
| **Error messages** | Leaking existence or names | Generic messages; details only in server logs |
| **Exports / CSV** | Bypassing DTO serialisation | Exports use the same DTO layer |

## 4. Test suite (release-blocking)

A shared harness creates two organisations with overlapping-looking data, then, for
**every** tenant-owned resource, asserts that Tenant A operating on Tenant B's ID gets 404
across: read, list, update, delete, evidence download, presigned URL, report download,
search, export, SSE subscription, and webhook delivery.

The harness is table-driven over a resource registry. **Adding a tenant-owned resource
without adding it to the registry fails CI**, so the coverage cannot rot as the product
grows — which is exactly how isolation bugs normally appear: not in the code that was
reviewed for isolation, but in the resource added six months later.

The harness above is Phase 3's, and does not exist yet — there is no tenant-owned REST
resource to drive it over. **The registry check itself does exist**: `pnpm check:registry`
runs in CI today and fails the build for an unregistered tenant-owned model, for a registry
entry that has gone stale in either direction, for a model accounted for by none or by more
than one of the three registries in `packages/db/src/tenant-resources.ts`, and for an unsafe
FK cascade (§2, Layer 2). So the *registration* half of "adding a resource without
registering it fails CI" is enforced now; the *assertion* half arrives with the resources it
would assert over.

Additional cases: removed member loses access immediately; suspended organisation blocks
all access; API key scoped to org A rejected against org B; a job enqueued for org A that
somehow names org B's resource fails safely.

## 5. Known residual risks

Recorded honestly rather than assumed away.

- **Platform admin break-glass** genuinely can cross tenants. Mitigated by separate
  authentication, mandatory reason, full audit, and owner notification — not eliminated.
- **Shared infrastructure.** One database and one Redis serve all tenants; a database
  compromise is a total compromise. Accepted for the current scale; per-tenant or
  per-region isolation is the enterprise escalation path, and the schema's explicit
  `organizationId` on every row is what would make that migration tractable.
- **Aggregate timing side channels.** Response times may weakly reveal that other tenants
  exist. Judged acceptable.
- **Redis cache keys.** Every cache key is prefixed with the organisation ID; a missing
  prefix would cross tenants. Covered by a key-construction helper that makes the prefix
  non-optional and a lint rule against raw key strings.
