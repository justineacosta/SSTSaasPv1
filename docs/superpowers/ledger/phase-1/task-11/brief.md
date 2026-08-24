### Task 11: Route access assertion and OpenAPI generation

Two structural controls that are cheap now and expensive to retrofit.

**Files:**
- Create: `apps/api/src/common/decorators/access.decorator.ts`, `apps/api/src/common/access-assertion.ts`, `apps/api/src/openapi/generate.ts`, `apps/api/src/openapi/cli.ts`
- Create: `apps/api/openapi.json` (generated, committed)
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/src/common/access-assertion.spec.ts`, `apps/api/src/openapi/generate.spec.ts`

**Interfaces:**
- Consumes: `@sentinel/contracts` (`Permission`)
- Produces:
  - `@Public()` — declares a route intentionally unauthenticated
  - `@RequirePermission(permission: Permission)` — declared in Phase 1, **enforced in Phase 2**
  - `ACCESS_METADATA_KEY`
  - `findRoutesWithoutAccessDeclaration(routes: RouteDescriptor[]): RouteDescriptor[]`
  - `assertEveryRouteDeclaresAccess(app: INestApplication): void`
  - `generateOpenApiDocument(app: INestApplication): OpenAPIObject`

- [ ] **Step 1: Write the failing assertion test**

`apps/api/src/common/access-assertion.spec.ts` tests the pure function, so it needs no Nest app:
```ts
import { describe, expect, it } from 'vitest';
import { findRoutesWithoutAccessDeclaration, type RouteDescriptor } from './access-assertion.js';

const route = (over: Partial<RouteDescriptor>): RouteDescriptor => ({
  controller: 'HealthController',
  handler: 'live',
  method: 'GET',
  path: '/health/live',
  access: undefined,
  ...over,
});

describe('findRoutesWithoutAccessDeclaration', () => {
  it('passes when every route declares its access', () => {
    expect(
      findRoutesWithoutAccessDeclaration([
        route({ access: { kind: 'public' } }),
        route({ handler: 'list', access: { kind: 'permission', permission: 'finding.read' } }),
      ]),
    ).toEqual([]);
  });

  it('reports a route with no declaration', () => {
    const offender = route({ controller: 'FindingsController', handler: 'destroy' });
    expect(findRoutesWithoutAccessDeclaration([offender])).toEqual([offender]);
  });

  it('lists every offender, not just the first — one boot should reveal all of them', () => {
    const offenders = [route({ handler: 'a' }), route({ handler: 'b' }), route({ handler: 'c' })];
    expect(findRoutesWithoutAccessDeclaration([...offenders, route({ access: { kind: 'public' } })]))
      .toHaveLength(3);
  });

  it('treats @Public as a declaration, not as an absence of one', () => {
    expect(findRoutesWithoutAccessDeclaration([route({ access: { kind: 'public' } })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails, then implement**

`access-assertion.ts` exposes the pure `findRoutesWithoutAccessDeclaration` plus
`assertEveryRouteDeclaresAccess`, which walks Nest's router explorer, builds `RouteDescriptor[]`
from the metadata both decorators set, and throws a single error naming every offender:

```
Startup refused: 3 route(s) declare no access requirement.

  DELETE /api/v1/findings/:id   FindingsController.destroy
  GET    /api/v1/findings       FindingsController.list
  POST   /api/v1/scans          ScansController.create

Every route must declare @Public() or @RequirePermission(...). Missing
authorization is a boot failure here rather than a production discovery.
See .claude/architecture/backend.md §3.
```

Wire it into `main.ts` immediately before `listen`. Add the docblock explaining why it exists
now rather than in Phase 2:

```ts
/**
 * A route without an explicit access declaration crashes startup.
 *
 * This lands in Phase 1, with one module, on purpose. Added in Phase 2 with
 * thirty routes already written, it would start life with a backlog of
 * offenders and get commented out on the first bad afternoon.
 */
```

- [ ] **Step 3: Implement OpenAPI generation**

Generate from the Zod contracts, serve at `/api/v1/openapi.json`, and write
`apps/api/openapi.json` via `pnpm --filter @sentinel/api openapi:generate`.

**Fallback if the Nest/Zod integration fights** (spec §5 flags this as medium likelihood):
generate the document with a standalone script from `packages/contracts` plus an explicit route
table, and still serve it and diff it. The CI diff is the part with value; how the document is
produced is not. Record which route was taken in the commit body.

- [ ] **Step 4: Assert the committed document matches the generated one**

```ts
it('the committed openapi.json matches what the code generates', async () => {
  const app = await bootstrapTestApp();
  const generated = generateOpenApiDocument(app);
  const committed = JSON.parse(
    readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
  ) as unknown;
  expect(generated).toEqual(committed);
});

it('documents every registered route', async () => {
  const app = await bootstrapTestApp();
  const document = generateOpenApiDocument(app);
  expect(Object.keys(document.paths ?? {})).toEqual(
    expect.arrayContaining(['/health/live', '/health/ready', '/health/detailed']),
  );
});
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(api): boot-time route access assertion and generated OpenAPI

A route declaring neither @Public nor @RequirePermission crashes startup,
with an error naming every offender rather than the first. Missing
authorization becomes a boot failure instead of a production discovery.

This lands in Phase 1 with one module on purpose: added in Phase 2 with
thirty routes already written, it would start with a backlog of offenders and
get switched off.

OpenAPI is generated from the Zod contracts, served at
/api/v1/openapi.json, and committed. A test asserts the committed document
matches what the code generates; CI diffs it in the next task.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

