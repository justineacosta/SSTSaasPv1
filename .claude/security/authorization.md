# Authorization architecture

> **Status: Partially Implemented (Phase 2, Tasks 12 and 13).** The pipeline is built, every
> layer below can deny, and **as of Task 13 it governs shipped endpoints**: `GET`, `PATCH` and `DELETE /api/v1/organizations/:id`, carrying `organization.read`,
> `organization.update` and `organization.delete`. Task 13 also ships
> `POST /api/v1/auth/switch-org`, the only writer of `Session.activeOrganizationId` — which is
> what makes layers 2 and 3 evaluate at all, since they short-circuit while that column is
> NULL. The layers are proved against those routes over the `sentinel_app` role, and still
> against purpose-built controllers for the cases no shipped route reaches. §5 and §10 say
> exactly which parts are live. Extended per phase as new resources appear.

## 1. The question authorization answers

Never `can this user do X?` — always:

```
can(principal, permission, resource) within organization
```

Four inputs, all required. A permission without an organisation is meaningless in a
multi-tenant product, and a permission without a resource cannot express "you may edit
findings in projects you are assigned to".

## 2. Layers

Evaluated in order; every layer can deny, none can override a denial.

1. **Authentication** — is there a valid principal? (401)
2. **Membership** — does the principal belong to this organisation, and is the membership
   active? (404, not 403 — see §6)
3. **Organisation state** — active, not suspended, subscription in good standing.
4. **Permission** — does the principal's effective permission set include the permission
   the route declares? (403)
5. **Resource scope** — does the resource belong to this organisation, and does any
   project- or team-level restriction permit it? (404)
6. **Entitlement** — does the plan allow this action or is a quota exhausted? (402)

**Where each layer lives, as of Task 12.** The order is the order of the `APP_GUARD`
providers in `apps/api/src/app.module.ts`, and `app.module.spec.ts` asserts it, because a
reordering is a one-line diff to an array that changes no type and still runs every guard.

| Layer | Mechanism | Status |
|---|---|---|
| 1 Authentication | `AuthenticationGuard` | Implemented (Task 7), session-cookie half only |
| 2 Membership | `TenantContextGuard` | Implemented (Task 12) |
| 3 Organisation state | `TenantContextGuard` | **Partially Implemented** — `Organization.status` is checked; "subscription in good standing" is Phase 10 and is not |
| 4 Permission | `AuthorizationGuard` | Implemented (Task 12) |
| 5 Resource scope | The tenant-scoped Prisma client, structurally | Implemented for the organisation half (Phase 1); the project- and team-level restrictions `GUEST` needs are not built |
| 6 Entitlement | `EntitlementGuard` | **Stub. Admits every request.** Phase 10. Registered anyway, last, so that 402 can never precede 403 — a stub that denies nothing is honest, a missing layer is a hole |

**Two layers deny only on a route that declares a permission**, and that asymmetry is
deliberate rather than an omission. A member who has just been removed from their only
organisation must still be able to read their own session document, sign out, and manage
their factors — every one of those is `@AuthenticatedOnly()`, about the *user* and about no
tenant (`authentication.md` §1). A rule that refused them would leave a valid credential
with no endpoint that answers it, including the one that ends the session. So an
`@AuthenticatedOnly()` route proceeds with no tenant resolved, and every consumer of that
value handles its absence.

**The active organisation comes from `Session.activeOrganizationId` and from nowhere else**
— never a path parameter, never a header, never a body field, per
`architecture/overview.md` §4. A request-supplied organisation id would make tenant
selection an input, and every membership check downstream a check on something the caller
chose. **Task 13 shipped the only writer of that column**, `POST /api/v1/auth/switch-org`, which
verifies an active membership and rotates the session before setting it. Before that nothing wrote
it and the guard short-circuited before its query on every request; it now runs the query for any
session that has switched, and still short-circuits for one that has not.

## 3. Permission model

Permissions are flat strings, `resource.action`, defined in one place in
`packages/contracts` and used identically by API guards and frontend affordances.

```
organization.read           project.read          asset.read
organization.update         project.create        asset.create
organization.delete         project.update        asset.update
organization.manage_members project.delete        asset.delete
organization.manage_roles                         asset.verify_ownership

scope.read      scan.read            finding.read           evidence.read
scope.update    scan.create          finding.create         evidence.upload
                scan.cancel          finding.update         evidence.delete
                scan.create_aggressive finding.delete
                                     finding.triage
                                     finding.accept_risk

engagement.read   report.read      apikey.read     webhook.read     billing.read
engagement.create report.create    apikey.create   webhook.create   billing.manage
engagement.update report.download  apikey.revoke   webhook.update
engagement.delete                                  webhook.delete

integration.read  integration.manage  audit.read  notification.manage
```

Two are deliberately separated from their obvious parents:

- **`scan.create_aggressive`** — running potentially disruptive tests is a different
  decision from running a scan, and most members should not have it.
- **`finding.accept_risk`** — accepting a risk is a business decision with compliance
  weight; it is not an ordinary triage action.

## 4. Roles

System roles ship seeded and immutable. Custom roles are per-organisation and may hold any
subset of permissions the creator themselves holds — you cannot mint authority you do not
possess, which closes the obvious privilege-escalation path.

> **The no-minting rule has an enforcement point as of Phase 2 Task 14, and it is not custom
> roles.** Custom roles are Phase 11. What enforces it today is `PATCH
> /api/v1/organizations/{id}/members/{membershipId}`: a member's role may only be changed to one
> whose permission set is a **subset of the actor's own effective set**, and the refusal is 403
> `PERMISSION_DENIED` naming the first permission the actor lacks, in the same `details` shape
> `AuthorizationGuard` produces. The case is concrete rather than theoretical — an `ADMIN` holds
> `organization.manage_roles` and not `organization.delete`, so without the check any `ADMIN`
> could promote a colleague, or a second account of their own, to `OWNER` and have them delete
> the organisation.
>
> **It is a set comparison and deliberately not a role ranking.** A ranking (`OWNER > ADMIN >
> ...`) is a second model of authority beside the table below, and the two drift the first time a
> permission moves between roles. The granted role's permissions are read from the seeded
> `RolePermission` rows — the same rows the guard decides against — so both sides of the
> comparison have one origin. `membership.service.spec.ts` asserts the rule over all 49 ordered
> pairs of system roles, deriving the expectation from `ROLE_PERMISSIONS` rather than from a
> transcribed table.

| Role | Intent | Notes |
|---|---|---|
| `OWNER` | Full control, billing, deletion | At least one per org, always; cannot be removed or demoted if last |
| `ADMIN` | Everything except billing and org deletion | |
| `SECURITY_LEAD` | Full security workflow, manages scope and triage | No member or billing management |
| `MEMBER` | Create and run scans, triage findings | No `accept_risk`, no `create_aggressive` |
| `VIEWER` | Read-only across the org | Includes report download |
| `AUDITOR` | Read-only **plus** `audit.read` | For compliance reviewers; deliberately cannot see evidence bodies |
| `GUEST` | Read-only, restricted to explicitly granted projects | External stakeholders |

Effective permissions = union of role permissions, minus organisation-level restrictions,
intersected with API key scopes when the principal is a key, and further constrained by
project/team grants for `GUEST`.

**What Task 12 computes is the first term only.** The effective set is the membership's role
expanded through the seeded `RolePermission` rows. Organisation-level restrictions, API key
scopes and `GUEST` project grants are all Not Implemented — no organisation-level
restriction exists to subtract, Phase 2 issues no API keys, and no project exists to grant.

**It is read fresh on every request, and there is no permission cache.**
`product/permissions.md` invariant 4 requires a role change to take effect on the member's
next request; a cache satisfies that only for as long as every writer remembers to
invalidate it, so the invariant is made structural instead — `Membership.roleId` is read by
the transaction that follows the write. Recorded because the Phase 2 plan asked for the
cache and this is a deliberate departure from it, taken by the operator on 2026-09-02. The
cost is one indexed statement pair inside one tenant transaction, paid only when the session
names an organisation. Adding a cache later is additive and needs a measurement this task
does not have.

## 5. Enforcement

Declarative at the route, evaluated centrally:

```ts
@Post('scans')
@RequirePermission('scan.create')
@RequireEntitlement('maxConcurrentScans')
create(@Ctx() ctx: TenantContext, @Body() dto: CreateScanDto) { ... }
```

A route with **no** permission decorator fails a startup assertion unless it is explicitly
marked `@Public()` or `@AuthenticatedOnly()`. Missing authorization is therefore a
crash at boot, not a silent hole discovered in production. A unit test enumerates every
route and asserts each carries an explicit access declaration.

> **Status of this section, as of Phase 2 Task 12.** All three declarations exist —
> `@Public()`, `@AuthenticatedOnly()` and `@RequirePermission()` — the boot assertion
> refuses a route carrying none of them, and **`@RequirePermission()` is now evaluated**.
> `AuthorizationGuard` reads `ACCESS_METADATA_KEY`, compares the declared permission
> against the effective set on `request.tenant`, and refuses with 403 `PERMISSION_DENIED`
> naming the permission, the caller's role and the roles that hold it. The sentence this
> banner carried from Task 7 to Task 11 — "read, and enforced by nobody" — is no longer
> true, and that is why this banner changed.
>
> **Seven shipped routes declare a permission as of Task 14, and the guard governs them.**
> Task 13 shipped the first three — `GET`, `PATCH` and `DELETE /api/v1/organizations/:id`,
> carrying `organization.read`, `organization.update` and `organization.delete`. Task 14 added
> four: `GET /api/v1/organizations/:id/members` and
> `DELETE /api/v1/organizations/:id/members/:membershipId` carrying
> `organization.manage_members`, `PATCH` on the same membership path carrying
> `organization.manage_roles`, and `GET /api/v1/roles` carrying `organization.read`. The guard
> was registered globally in Task 12 precisely so that routes were governed from the moment they
> were written rather than from the moment somebody remembered to add a guard, and that is what
> happened both times: no change to the guard was needed to bring any of the seven under it.
>
> The count is pinned in code rather than only stated here.
> `authorization-matrix.integration.spec.ts` holds `EXPECTED_GUARDED_ROUTES` as an exact
> `METHOD path -> permission` map and fails if a route is added, removed, or downgraded from
> `@RequirePermission()` to `@AuthenticatedOnly()` — the last of which the matrix's arms cannot
> otherwise notice, because a route declaring no permission simply leaves the set they iterate.
>
> Proof is in `authorization.guard.spec.ts` (purpose-built controllers through the real guard
> chain), `authorization.integration.spec.ts` (real seeded rows, real row-level security, over
> the `sentinel_app` role), `organizations.scoped.integration.spec.ts` (the shipped routes,
> same role) and `authorization-matrix.integration.spec.ts`, which runs all four arms of §10's
> exit criterion over the live route inventory.
>
> **One arm is inapplicable rather than passing**, and it is worth naming: every system role
> holds `organization.read`, so no caller exists who could produce a 403 on `GET
> /organizations/:id` or on `GET /roles`. The matrix records that arm as
> evaluated-and-inapplicable rather than as covered. The other five routes produce real 403s.
>
> **The cross-tenant arm runs one of two probes, declared per route.** A route with a tenant id
> in its path is probed by pointing a real, active member of another organisation at their own
> organisation id — so the only thing that can refuse the request is the handler's
> path-versus-tenant check. `GET /api/v1/roles` is the first guarded route with no tenant-owned
> resource in its path, and it is probed instead by pointing a session at an organisation the
> caller holds no membership in, which is §3's `not-a-member` row and `TenantContextGuard`'s
> refusal. Neither probe covers a correct path id carrying **another tenant's resource id**;
> that is proved per resource in the resource's own integration suite, because the matrix cannot
> know what a resource of an arbitrary future route looks like.
>
> **`@RequireEntitlement` in the example above does not exist and is deliberately not
> built.** Phase 10 ships the decorator and its evaluation in one change. A decorator that
> routes could carry while nothing evaluated it is precisely the state
> `@RequirePermission()` was in for five tasks, and it was misread as enforcement at least
> once. `EntitlementGuard` — the layer — is registered and admits everything; there is no
> way for a route to declare an entitlement, so no route can be wrong about one.

Resource-level checks are not optional extras: loading a resource always goes through the
tenant-scoped client, so a resource in another organisation is simply not found.

## 6. Why 404 and not 403 for cross-tenant

Returning 403 for a resource in another tenant confirms the resource exists. That is an
information leak that lets an attacker enumerate IDs and map another customer's estate.
Cross-tenant access returns **404**, identical to a genuinely absent resource.

403 is reserved for *your own* organisation's resources that your role does not permit —
where the existence of the resource is already known to you.

## 7. API key scopes

A key holds a permission subset chosen at creation, never exceeding the creator's own set.
Keys are bound to one organisation, may carry an expiry and an IP allowlist, record
`lastUsedAt`, and are independently revocable. Revoking a key takes effect immediately —
the lookup cache is invalidated on revocation, like sessions.

Some permissions are **never** grantable to an API key: `organization.delete`,
`organization.manage_roles`, `billing.manage`, `apikey.create`. A leaked key must not be
able to entrench itself or empty the bank account.

## 8. Platform administration

Platform operators are **not** tenant users with extra flags. They authenticate through a
separate path with mandatory hardware-backed MFA, hold `PlatformRole` rather than
membership, and are subject to their own audit stream marked `actorType=PLATFORM_ADMIN`.

Platform admins can manage organisations, subscriptions, abuse, flags, and system health.
They **cannot** silently read tenant findings or evidence: such access requires an explicit,
reason-tagged break-glass action that is audited and **notifies the organisation owner**.
Detail: [`../architecture/platform-admin.md`](../architecture/platform-admin.md).

## 9. Frontend

The frontend receives the effective permission set for the active organisation and uses it
to hide or disable affordances. This is **UX only**. Every action it permits is
independently re-authorised server-side; every action it hides is still rejected server-side
if called directly. Hiding a button is not a security control and must never be described
as one.

## 10. Testing requirements

For every endpoint: unauthenticated → 401; authenticated without permission → 403;
authenticated in a different tenant → 404; correct permission → 200. This matrix is
generated from the route table so a new endpoint without tests fails CI. Plus: custom role
cannot exceed creator's permissions, API key cannot exceed its scopes, last owner cannot be
demoted, guest cannot reach ungranted projects, and revocation of session or key takes
effect on the next request.

**What is built, as of Task 14, and what the green tick does not cover.**
`apps/api/src/common/authorization-matrix.integration.spec.ts` enumerates the live route
inventory, asserts the arms each route's declaration implies, and — the part that makes it
a matrix rather than a checklist — **fails on any route it did not exercise**. A new
endpoint is therefore covered the moment it is written.

Two things the tick would otherwise imply more about than it proves — the first of which was a
limit through Task 13 and is now closed:

- **The 403 and cross-tenant-404 arms run over seven shipped routes as of Task 14** — the three
  on `/api/v1/organizations/{id}` (Task 13, the first endpoints in this product to declare a
  permission), the three on `/api/v1/organizations/{id}/members`, and `GET /api/v1/roles`. Before
  Task 13 they ran over none, and the sentence here said so. The downgrade limit this bullet used
  to record is **closed**: the matrix now pins `EXPECTED_GUARDED_ROUTES` as an exact
  `METHOD path -> permission` map, so a single route dropped to `@AuthenticatedOnly()` fails it by
  name rather than silently leaving the set the arms iterate. Measured in Task 14 by downgrading
  `DELETE /api/v1/organizations/{id}/members/{membershipId}`: the matrix's pin went red, as did
  the per-route access table in `memberships.controller.spec.ts` and the scoped 403 arm.
- **It drives the application as `sentinel_app`, not as the schema owner.** The default
  integration harness connects as a superuser that bypasses row-level security, under which
  an authorization suite proves that Postgres has policies rather than that this code obeys
  them. Measured: removing the tenant transaction from the resolver turns 9 of the 18
  assertions in `authorization.integration.spec.ts` red, and would not have under the owner.

Of the list after "Plus:" in the paragraph above, **two are now built and two are not**. The
**last-owner invariant** is enforced and tested as of Task 14 — under a row lock, with the
unlocked version measured against real Postgres to prove the race is real
(`memberships/last-owner.integration.spec.ts`). **"A role cannot exceed its granter's
permissions"** is enforced for role changes (§4's banner) and tested exhaustively over all 49
ordered pairs of system roles, although *custom roles* themselves remain Phase 11. Still **Not
Implemented**: API key scopes, because Phase 2 issues no keys, and `GUEST` project grants, which
need projects and are Phase 3.
