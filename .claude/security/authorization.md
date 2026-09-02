# Authorization architecture

> **Status: Partially Implemented (Phase 2, Task 12).** The pipeline is built and every
> layer below can deny. **It governs no shipped endpoint**, because no route in this API
> declares `@RequirePermission()` yet — the eighteen Phase 2 routes are `@Public()` or
> `@AuthenticatedOnly()`, and Tasks 13–15 ship the first guarded ones. The layers are
> proved against purpose-built controllers and against real seeded rows over the
> `sentinel_app` role, not against a production route. §5 and §10 say exactly which parts
> are live. Extended per phase as new resources appear.

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
chose. **Nothing writes that column until Task 13**, so in production today the guard
short-circuits before its query on every request.

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
> **No shipped route declares a permission, so the guard governs nothing yet.** The
> eighteen routes Phase 2 publishes are `@Public()` or `@AuthenticatedOnly()`; Tasks 13–15
> ship the first guarded ones, and the guard is registered globally so that they are
> governed from the moment they are written rather than from the moment somebody remembers
> to add a guard. Proof is in `authorization.guard.spec.ts` (purpose-built controllers
> through the real guard chain) and `authorization.integration.spec.ts` (real seeded rows,
> real row-level security, over the `sentinel_app` role).
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

**What is built, as of Task 12, and what the green tick does not cover.**
`apps/api/src/common/authorization-matrix.integration.spec.ts` enumerates the live route
inventory, asserts the arms each route's declaration implies, and — the part that makes it
a matrix rather than a checklist — **fails on any route it did not exercise**. A new
endpoint is therefore covered the moment it is written.

Two limits, stated because the tick would otherwise imply more than it proves:

- **The 403 and cross-tenant-404 arms run over zero shipped routes**, because no endpoint
  declares `@RequirePermission()` yet. What the matrix proves about the shipped API is that
  every non-public route refuses an unauthenticated caller and that no route escapes
  classification. The arms themselves are exercised in
  `authorization.integration.spec.ts` against real seeded rows.
- **It drives the application as `sentinel_app`, not as the schema owner.** The default
  integration harness connects as a superuser that bypasses row-level security, under which
  an authorization suite proves that Postgres has policies rather than that this code obeys
  them. Measured: removing the tenant transaction from the resolver turns 9 of the 18
  assertions in `authorization.integration.spec.ts` red, and would not have under the owner.

Everything after "Plus:" in the paragraph above is **Not Implemented**: custom roles are
Phase 11, API keys are not issued in Phase 2, the last-owner invariant is Task 14's, and
`GUEST` project grants need projects, which are Phase 3.
