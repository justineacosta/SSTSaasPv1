# Authorization architecture

> **Status: Designed. Not Implemented.** Built in Phase 2, extended per phase as new
> resources appear.

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

> **Status of this section, as of Phase 2 Task 7.** All three declarations now exist —
> `@Public()`, `@AuthenticatedOnly()` and `@RequirePermission()` — and the boot assertion
> refuses a route carrying none of them (proved by booting the real application with one).
> **`@RequirePermission` is read, and enforced by nobody** — the distinction matters and an
> earlier version of this banner got it wrong by saying "read by nobody". `ACCESS_METADATA_KEY`,
> the single key it writes, is read by `AuthenticationGuard` (to decide the route is not
> public, which is why a permission-guarded route authenticates at all), by
> `route-inventory.ts` for the boot assertion, and by the OpenAPI generator. What no code
> does is **evaluate the permission**. The guard that would, and the `TenantContext` it
> needs, are Task 12's; today a route naming a permission is authenticated and then
> admitted. `@RequireEntitlement` is Phase 10. The example above
> therefore compiles and boots, and two of its three decorators enforce nothing yet.

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
