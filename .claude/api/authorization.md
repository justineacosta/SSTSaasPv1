# API authorization

> **Status: Partially Implemented (Phase 2, Tasks 12 through 15).** §1's declarations exist and
> `@RequirePermission()` is evaluated; §3's status codes are produced by
> `TenantContextGuard` and `AuthorizationGuard`; §4's envelope is what a 403 actually
> carries. **Ten shipped endpoints declare a permission** as of Task 15 — the three on
> `/api/v1/organizations/:id` from Task 13, carrying `organization.read`, `organization.update`
> and `organization.delete`; the three on `/api/v1/organizations/:id/members`, carrying
> `organization.manage_members`, `organization.manage_roles` and `organization.manage_members`;
> `GET /api/v1/roles`, carrying `organization.read`; and the three on
> `/api/v1/organizations/:id/invitations` from Task 15, all three carrying
> `organization.manage_members`. So §3's rows are reachable by a caller.
>
> **An eleventh route exists and declares no permission on purpose.**
> `POST /api/v1/invitations/accept` is `@AuthenticatedOnly()`: the acceptor is a member of
> nothing, so there is no tenant to authorize against and any `@RequirePermission()` would deny
> by construction. It is deliberately absent from `EXPECTED_GUARDED_ROUTES`, and the boot-time
> access assertion still requires it to declare *something*.
> The sentence this banner carried through Task 12, "no shipped endpoint declares a permission",
> is what changed at Task 13, and the count is computed from the `@RequirePermission()`
> decorators rather than remembered — this banner said "three" for one task longer than it was
> true, which is why it now says how it was counted. `authorization-matrix.integration.spec.ts`
> pins the same ten as `METHOD path -> permission`.
> `@RequireEntitlement` in §1's example does not exist (Phase 10). §5's project-scoped
> half is not built.
> Model and permission list: [`../security/authorization.md`](../security/authorization.md)
> and [`../product/permissions.md`](../product/permissions.md). This document covers how it
> appears on the wire and how endpoints declare it.

## 1. Declaration

Every route declares its access requirement. There is no implicit default.

```ts
@Get('findings')
@RequirePermission('finding.read')
list(@Ctx() ctx: TenantContext, @Query() q: ListFindingsDto) { ... }

@Post('scans')
@RequirePermission('scan.create')
@RequireEntitlement('maxConcurrentScans')
create(@Ctx() ctx: TenantContext, @Body() dto: CreateScanDto) { ... }

@Get('health/live')
@Public()
live() { ... }
```

A route with no `@RequirePermission`, `@AuthenticatedOnly()`, or `@Public()` **fails an
assertion at application startup**. Missing authorization is a boot crash, not something
discovered in production. A separate test enumerates the route table and asserts every entry
carries an explicit declaration, so the assertion cannot be quietly disabled.

## 2. What the client can see

```
GET /api/v1/auth/session
```

```jsonc
{ "user": { "id": "usr_01J...", "email": "marcus@acme.example", "mfaEnabled": true },
  "organization": { "id": "org_01J...", "name": "Acme Corp", "role": "ADMIN" },
  "permissions": ["organization.read", "project.create", "scan.create", ...],
  "entitlements": { "maxConcurrentScans": 10, "sso": false, ... } }
```

**What the shipped document actually contains** — `sessionResponseSchema`, and the sketch
above is the design rather than the current shape: `userId`, `activeOrganization`,
`permissions` and `entitlements`, with no `user` object and no `mfaEnabled`. The session
identifier is deliberately absent.

`permissions` became real in Task 12: it is the effective set for the session's active
organisation, computed by `TenantContextGuard` from the membership's role. **It is `[]` on
every session that exists**, because the set is empty exactly when no tenant resolved and
nothing writes `Session.activeOrganizationId` until Task 13 — so the observable response
has not changed, only the reason for it. An empty array is also what a member of a
suspended organisation receives: they may do nothing there, so an *effective* set of
nothing is the accurate report. `entitlements` is still `{}` and is Phase 10.

The frontend uses `permissions` to hide or disable affordances
([`../architecture/frontend.md`](../architecture/frontend.md) §5). **This is UX only.** The
list is a mirror of server-side rules, never the rules themselves; every action it permits is
re-authorised server-side, and every action it hides is still rejected if called directly.

Permissions are re-fetched on organisation switch and reflect a role change on the next
request, so a demoted user's UI catches up immediately rather than at a cache TTL. As of
Task 12 that holds because **there is no cache to expire**: the effective set is read from
`Membership` and its `Role` on every request that names an organisation. The reasoning, and
why the plan's permission cache was not built, is in
[`../security/authorization.md`](../security/authorization.md) §4.

## 3. Status codes

| Situation | Status | Code | Built |
|---|---|---|---|
| Not authenticated | 401 | `UNAUTHENTICATED` | Task 7 |
| Not a member of the target organisation | **404** | `RESOURCE_NOT_FOUND` | Task 12 |
| Session names no organisation at all | **404** | `RESOURCE_NOT_FOUND` | Task 12 |
| Member, lacks the permission | 403 | `PERMISSION_DENIED` | Task 12 |
| Resource belongs to another tenant | **404** | `RESOURCE_NOT_FOUND` | Structural, Phase 1 |
| Organisation suspended | 403 | `ORGANIZATION_SUSPENDED` | Task 12 |
| Entitlement exhausted | 402 | `QUOTA_EXCEEDED` | Phase 10 |
| Plan does not include the feature | 402 | `FEATURE_NOT_AVAILABLE` | Phase 10 |
| Granting a role whose permissions you lack | 403 | `PERMISSION_DENIED` | Task 14 |
| Removing a member whose role holds permissions you lack | 403 | `PERMISSION_DENIED` | Task 14 fix round |
| A write that would leave an organisation with no owner | **422** | `INVALID_STATE_TRANSITION` | Task 14 |

**The three Task 14 rows are refusals from inside a handler, not from a guard**, and they are the
first of that kind in this API. The two 403s carry the same `details` shape §4 documents — they
are built by the same function `AuthorizationGuard` uses, and by the same helper as each other —
and name the first permission the actor lacks, so `ADMIN` promoting somebody to `OWNER`, or
removing an `OWNER`, both read `"required": "organization.delete"`. The
422 is `api/conventions.md` §2's "valid shape, failed a domain rule": the body parsed, the
membership exists, and the caller holds the permission; what refuses is the state of the
organisation.

**Row three is new and it is the same response as row two, byte for byte.** A session that
has chosen no organisation and a session pointed at an organisation the caller does not
belong to both produce the identical 404 — same status, same body, same headers, asserted
as an identity rather than as two expectations. They are distinguished internally only
because the difference decides what `GET /auth/session` reports about itself.

**`NOT_A_MEMBER` exists in the error-code list and has no producer, deliberately.** This
table maps that situation onto `RESOURCE_NOT_FOUND`, and a distinct code on the wire would
be the disclosure the whole of §3 exists to prevent.

**Cross-tenant access returns 404, never 403.** A 403 confirms the resource exists, which lets
an attacker enumerate IDs and map another customer's estate. 403 is reserved for resources
within *your own* organisation whose existence you already know about. This is the single most
important rule in this document, and it applies to every endpoint, every export, every file
download, and every event stream.

## 4. Useful denials

A 403 states which permission is missing and who can grant it, so the user can act rather than
file a ticket:

```jsonc
{ "error": { "code": "PERMISSION_DENIED",
    "message": "You need the \"finding.accept_risk\" permission to do this.",
    "details": { "required": "finding.accept_risk", "yourRole": "MEMBER",
                 "rolesWithPermission": ["OWNER", "ADMIN", "SECURITY_LEAD"] },
    "requestId": "req_..." } }
```

**`details` is exactly what is shipped**, asserted field by field. The `message` is the
permission key rather than a human label for it — this document previously showed
`"Accept risk"`, and there is no mapping from a permission to a display name anywhere in
the codebase, so writing one would have meant inventing a second list to keep in step with
`PERMISSIONS`. The frontend keys on `details.required` and renders whatever label it likes.

`rolesWithPermission` is computed from `ROLE_PERMISSIONS` in `packages/contracts`, while
the refusal itself is decided against the seeded `RolePermission` rows. That is two sources
for one fact, and it is safe in one direction only — a drift would produce a misleading
hint and never a wrong answer — but the drift is closed anyway:
`authorization.integration.spec.ts` asserts the seeded rows expand to exactly
`ROLE_PERMISSIONS` for all seven system roles.

We never list *which users* hold the permission — that is organisation membership detail the
caller may not be entitled to. Roles are safe; names are not.

## 5. Resource-level authorization

Permission checks answer "may you do this kind of thing". They do not answer "to this
object". Object-level authorization is structural: every load goes through the tenant-scoped
Prisma client, so a resource in another organisation is simply not found, and project-scoped
principals (`GUEST`) have their project grants applied inside the query rather than checked
afterwards.

There is no code path where a handler receives an unscoped client and remembers to filter. The
scoping is in the client, not the handler
([`../security/tenant-isolation.md`](../security/tenant-isolation.md) §2).

**As of Task 12 a handler gets the scoping as a runner, not as a client**, and the
distinction matters. `tenantRunnerFor` in `common/decorators/ctx.decorator.ts` returns a
function bound to the resolved `organizationId` that runs its callback inside
`withTenantTransaction`. A bare client would carry layer 1 (the client extension) and
silently drop layer 2 (row-level security), which is activated by `SET LOCAL
app.organization_id` inside a transaction — the exact defect `withTenantTransaction`'s own
docblock records having shipped once. The organisation id is closed over rather than passed,
so a handler cannot scope to one it read off the request. **`@Ctx()` is used by six shipped
handlers** as of Task 14 — the three `:id` routes on `OrganizationsController` and the three on
`MembershipsController`. All six open their tenant transactions through `withTenantTransaction`
directly rather than through `tenantRunnerFor`, because they need the same transaction to carry
the audit write — and, on the membership writes, the `SELECT ... FOR UPDATE` that serialises the
last-owner check. The runner remains the shape for a handler that only reads.
`GET /api/v1/roles` takes no `@Ctx()` at all: it answers from deliberately-global reference data
(`Role`, `Permission`, `RolePermission`), which carries no `organizationId` and no row-level
security, so there is no tenant predicate for a transaction to supply. It still declares
`organization.read`, so a caller reaches it only once a tenant has been resolved.

**The `GUEST` half of this section is Not Implemented.** Project- and team-level grants need
projects, which are Phase 3. `PROJECT_SCOPED_PERMISSIONS` exists in `packages/contracts` and
nothing reads it.

## 6. Testing

The authorization matrix is **generated from the route table**, so a new endpoint gets tests
automatically and an endpoint without them fails CI. For every route: unauthenticated → 401;
authenticated without the permission → 403; authenticated in a different tenant → 404; correct
permission → success. Plus: API key scope intersection, custom roles not exceeding their
creator, last-owner protection, guest project restriction, and immediate effect of revocation
and role change.

**Of that "plus" list, three are built as of Task 14.** *Last-owner protection* is enforced under
a row lock on the organisation and tested against real Postgres in both directions — the unlocked
algorithm is run on two concurrent connections and measured leaving the organisation with zero
owners, which is what makes the locked version's pass mean anything. *Roles not exceeding their
granter* is enforced on the role-change endpoint and asserted over all 49 ordered pairs of system
roles, though custom roles themselves are Phase 11. *Immediate effect of a role change* is
asserted over the promoted member's own unchanged session cookie, and *immediate effect of
revocation* over a removed member's next request. API key scopes and guest project restrictions
have nothing to test yet — Phase 2 issues no keys and Phase 3 brings projects.

**A route with no tenant-owned resource in its path takes a different cross-tenant probe**, and
`GET /api/v1/roles` is the first. The matrix declares per route which of the two applies rather
than deriving it, because an arm that cannot reach the check it is named after passes while
proving nothing. What neither probe covers — a correct path id carrying another tenant's
*resource* id — is proved in each resource's own integration suite.
