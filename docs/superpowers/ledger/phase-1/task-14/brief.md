### Task 14: CI checks — OpenAPI diff, tenant registry completeness, and the recorded carry-forwards

Base: `21746c5` on `feat/phase-1-foundation`. Tree clean at dispatch.

This is the CI-checks task. The plan gives it two checks; the execution ledger has parked six
more requirements on it across Tasks 6, 9, 12 and 13. Every one of those is recorded in
`.claude/product/roadmap.md` "Known outstanding" as owed to **this** task, not suggested. They
are in scope. The deferrals at the bottom are also explicit — do not do them.

The shape every check in this task shares, and the reason they belong together: a guarantee that
Phase 1 established by hand rots the moment the schema, the route table, or the spec-file layout
grows past what a human last looked at. Each check re-derives the guarantee from the artefact
that actually defines it (the Prisma DMMF, the Nest route inventory, Vitest's own project
resolution) rather than from a list someone remembered to update.

---

**Files:**
- Create: `scripts/check-tenant-registry.ts`, `scripts/check-tenant-registry.spec.ts`
- Create: `scripts/check-openapi-diff.ts`
- Create: `scripts/check-vitest-projects.ts` (+ its spec if any logic in it is pure)
- Modify: `.github/workflows/ci.yml`, root `package.json`, `eslint.config.js`
- Modify: `packages/db/src/tenant-resources.ts` (the deliberately-global registry)
- Modify: `.claude/development/migrations.md`, `.claude/security/tenant-isolation.md`,
  `.claude/development/setup.md`, `CLAUDE.md` (only where this change makes them wrong)

**Interfaces:**
- Consumes: `TENANT_OWNED_MODELS` / `TENANT_ROOT_MODEL` (Task 6), `generateOpenApiDocument` and
  `apps/api/openapi.json` (Task 11), `vitest.workspace.ts` (Tasks 1/12)
- Produces: `pnpm check:registry`, `pnpm check:openapi`, `pnpm check:specs`
- Produces (pure, unit-tested):
  - `findUnregisteredTenantModels(models: ModelInfo[], registry: readonly string[]): string[]`
  - `findStaleRegistryEntries(models: ModelInfo[], registry: readonly string[]): string[]`
  - `findUnaccountedModels(...)` and `findUnsafeCascades(...)` — signatures yours to choose
  - `interface ModelInfo { name: string; fields: string[] }` (extend as the new rules need, but
    keep the four tests below passing on the shape the plan specified)

---

- [ ] **Step 1: Write the failing registry-check test**

`scripts/check-tenant-registry.spec.ts` — the functions are pure, so no database is needed.
The `unit` Vitest project already includes `scripts/**/*.spec.ts`, so this file is claimed;
confirm that rather than assuming it (Step 6 gives you the tool to confirm it with).

```ts
import { describe, expect, it } from 'vitest';
import {
  findStaleRegistryEntries,
  findUnregisteredTenantModels,
  type ModelInfo,
} from './check-tenant-registry.js';

const membership: ModelInfo = { name: 'Membership', fields: ['id', 'organizationId', 'userId'] };
const asset: ModelInfo = { name: 'Asset', fields: ['id', 'organizationId', 'name'] };
const user: ModelInfo = { name: 'User', fields: ['id', 'email'] };

describe('findUnregisteredTenantModels', () => {
  it('returns nothing when every organizationId model is registered', () => {
    expect(findUnregisteredTenantModels([membership], ['Membership'])).toEqual([]);
  });

  it('reports a model carrying organizationId that is not registered', () => {
    expect(findUnregisteredTenantModels([membership, asset], ['Membership'])).toEqual(['Asset']);
  });

  it('ignores global models', () => {
    expect(findUnregisteredTenantModels([user], [])).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const another: ModelInfo = { name: 'Finding', fields: ['id', 'organizationId'] };
    expect(findUnregisteredTenantModels([asset, another], [])).toEqual(['Asset', 'Finding']);
  });
});

describe('findStaleRegistryEntries', () => {
  it('reports a registered model that no longer carries organizationId', () => {
    expect(findStaleRegistryEntries([{ name: 'Membership', fields: ['id'] }], ['Membership'])).toEqual(
      ['Membership'],
    );
  });

  it('reports a registered model that no longer exists at all', () => {
    expect(findStaleRegistryEntries([], ['Membership'])).toEqual(['Membership']);
  });

  it('returns nothing when the registry is accurate', () => {
    expect(findStaleRegistryEntries([membership], ['Membership'])).toEqual([]);
  });
});
```

Checking both directions matters. A registry that lists a model which lost its `organizationId`
gives false confidence that something is covered when it no longer needs to be — and hides the
fact that a table stopped being tenant-owned, which is itself worth a second look.

Write the tests for the two **additional** rules (Steps 2b and 2c) in the same file, in the same
style, before implementing them.

- [ ] **Step 2: Run, verify failure, implement**

`scripts/check-tenant-registry.ts` reads model info from the generated Prisma DMMF
(`Prisma.dmmf.datamodel.models`), runs the pure functions, and exits 1 with a message that tells
the reader what to do:

```
Model "Asset" carries organizationId but is not in TENANT_OWNED_MODELS.

A tenant-owned table that is not registered will not be covered by the
cross-tenant isolation harness. Add it to
packages/db/src/tenant-resources.ts, enable RLS on it in a migration, and add
its cross-tenant assertions.

See .claude/development/migrations.md §5.
```

The root workspace has no dependency on `@sentinel/db` today — adding
`"@sentinel/db": "workspace:*"` to root `devDependencies` is the expected way to import the DMMF
and the registry. If you find a reason that is wrong, say so and pick another; do not import
across packages by relative path.

- [ ] **Step 2b: The FK-cascade structural rule** *(carried from Task 6, ruled)*

Ruling on file, from Task 6's fix round 3:

> Make the class STRUCTURAL, not a one-off. Task 14's `check-tenant-registry.ts` gains a second
> rule — no FK **into** a tenant-owned table, from a parent that is not itself tenant-scoped, may
> be `ON DELETE CASCADE`. Reads `onDelete` from the DMMF. Why: fixing one FK leaves the next to
> be found by a reviewer or a customer.

Context you need, because it is the qualifier the rule loses if you state it carelessly. Task 6
found and fixed a live instance: `Membership.userId → User` was `Cascade`, so deleting a `User`
destroyed tenant B's membership rows. The reviewer proved it by reverting the constraint on a
live database and watching tenant B's data disappear. But `Membership_organizationId` and
`Invitation_organizationId` **are** `Cascade` and are **correct** — the parent there is the
tenant root deleting its own rows. A rule stated as "every FK into a tenant-owned table is
RESTRICT" is false, and `security/tenant-isolation.md` was corrected once already for saying
exactly that. Your rule must carry the "from a parent that is not itself tenant-scoped"
qualifier, and its failure message must explain it, or it will be either wrong or ignored.

Two things to establish by measurement before you write the check, not after:

1. **Does the DMMF actually carry `onDelete`?** Prisma populates `relationOnDelete` on relation
   fields. Determine empirically whether it is present when the schema omits `onDelete` and
   Prisma applies its default. If it is absent, decide and *document in the code* what the check
   assumes for an omitted action, and make sure the assumption is the safe direction (an omitted
   action must not silently pass a rule it would fail if written out). Print what you measured.
2. **Does the check pass on today's schema?** It must. If it flags something, that is either a
   real defect Task 6 missed or a bug in your rule — find out which before changing anything.

- [ ] **Step 2c: Every model accounted for exactly once** *(carried from Task 6, ruled — closes N5)*

> A check keyed on the `organizationId` column can never flag `Organization`, the model that
> leaked hardest, so every model must be accounted for by exactly one of tenant-owned /
> tenant-root / deliberately-global.

`packages/db/src/tenant-resources.ts` already anticipates this in the `TENANT_ROOT_MODEL`
docblock — read it; it names this task. Add the third registry (a `DELIBERATELY_GLOBAL_MODELS`
export, or whatever you name it) listing `User`, `Credential`, `Session`, `Role`, `Permission`,
`RolePermission` — each with a one-line reason it is global, because an unexplained entry on that
list is how a tenant-owned table gets parked there to make the build go green. Then the check
fails when a model appears in none of the three, or in more than one.

- [ ] **Step 3: The OpenAPI diff check**

`scripts/check-openapi-diff.ts` regenerates the document, compares it to `apps/api/openapi.json`,
prints a readable diff, and exits 1 on mismatch with:

```
The committed OpenAPI schema does not match what the contracts generate.
Run `pnpm --filter @sentinel/api openapi:generate` and commit the result.
If this diff removes or renames a field, it is a BREAKING change and needs
/api/v2 — see .claude/api/conventions.md §8.
```

The plan's one-line implementation (`node --experimental-strip-types scripts/check-openapi-diff.ts`
importing the generator directly) does **not** work as written, and you should confirm that
rather than take my word for it: generating the document boots the Nest `AppModule`, which needs
decorator metadata that Node's type-stripping does not emit. `apps/api`'s own
`openapi:generate` script exists precisely because of this — it runs `tsc -p tsconfig.build.json`
first and then `node dist/openapi/cli.js`.

Design the check around that constraint. Two properties matter more than which approach you pick:

- **It must not leave the working tree dirty on success.** Today's `openapi:generate` writes
  `apps/api/openapi.json` in place. A check that regenerates over the committed file and then
  compares has already destroyed the evidence. Generate to a temp path (an env var or argv on
  `cli.ts` is a legitimate, small change), or read-then-restore — but if you restore, prove the
  restore happens on the failure path too.
- **The comparison must be a real comparison, and the diff must be readable.** "Not byte-equal"
  is not a diff. A reviewer reading a red CI log should be able to see which path or field moved.

Note what already exists so you do not duplicate it: `apps/api/src/openapi/generate.integration.spec.ts`
asserts the committed file is byte-identical to what the code generates. That test runs under
`pnpm test:integration`, which needs the Docker stack. The CI check earns its place by running in
the cheap lane, without Postgres — say so plainly in the script's header comment, and do not
claim it covers something the test already covers.

- [ ] **Step 4: The spec-project coverage guard** *(carried from Task 12, ruled — REQUIRED)*

Ruling on file:

> Build a check that every `*.spec.*` file under `packages/*/src` and `apps/*/src` is matched by
> exactly one Vitest project, and fail CI otherwise. Origin: three instances of the silent-skip
> trap on Task 12 alone. Patching globs one at a time is losing to it. Cost if wrong: if Task 14
> drops the guard, the class survives with only its current instances closed.

The trap: a spec filename that matches no Vitest project passes green under `--passWithNoTests`
while executing nothing. Task 12 hit three separate spellings of it, and the **third was created
by the fix round for the second**. Read `vitest.workspace.ts` — the comments there narrate all
three.

The check must cover `scripts/**/*.spec.ts` too, since this task adds one there.

**Re-deriving Vitest's glob matching by hand is the wrong implementation** — a reimplementation
that disagrees with Vitest is a check that lies in the direction of green. Vitest's own Node API
(`createVitest` from `vitest/node`, then each resolved project's file globbing) gives you the
ground truth from the same code that runs the suite. Verify the API shape against the installed
Vitest 3 before building on it; if it turns out not to expose what you need, say so with the
evidence and fall back deliberately.

Both failure directions must be caught: **zero** projects (silent skip) and **two or more**
(a file running twice under different environments, which is how a jsdom spec silently also runs
under Node).

- [ ] **Step 5: Prove every check actually fails**

Do not trust a check you have not watched fail. Drill each one, capture the real output, restore,
and confirm green again. Minimum set:

```bash
# registry: temporarily remove 'Invitation' from TENANT_OWNED_MODELS
pnpm check:registry     # expect exit 1 naming Invitation; restore; expect exit 0
# registry, stale direction: add a model name that does not exist
# registry, accounting: add a new model to the schema in none of the three registries
# registry, FK cascade: flip Membership.userId back to onDelete: Cascade in the schema
#   (this is the exact live defect Task 6 fixed — the check must catch it)
# openapi: hand-edit one field in apps/api/openapi.json
pnpm check:openapi      # expect exit 1 with a readable diff; restore; expect exit 0
# specs, zero-project: create a temp packages/ui/src/__probe__.spec.jsx (or any
#   extension no project claims) and a temp apps/web/src/__probe__.integration.spec.tsx
#   variant — reproduce the ACTUAL Task 12 trap, not a strawman
pnpm check:specs        # expect exit 1 naming the file; delete; expect exit 0
# specs, two-project: make one file match two projects
```

Regenerating Prisma after a schema edit is part of the drill for the DMMF-driven rules — a check
that reads a stale generated client is not reading your edit. Confirm you are testing what you
think you are testing.

Report each drill with the command and the actual output. A drill you did not run has no row.

- [ ] **Step 6: `eslint-plugin-react-hooks`** *(carried from Task 13 review — IMPORTANT)*

`grep -n react eslint.config.js` returns nothing, and `apps/web/app/providers.tsx` has three
hooks with dependency arrays and a lazy `useState` initialiser that nothing in the toolchain
checks. The Task 13 review confirmed the dependencies are correct **today**, so this is a missing
guard over the most common React defect class, not a present bug.

Add `eslint-plugin-react-hooks` (and `eslint-plugin-react` if the config needs it) to the root
devDependencies and wire it into `eslint.config.js`, scoped to the files that are actually React
(`apps/web/**`, `packages/ui/**`) rather than workspace-wide. `pnpm lint` must be green when you
are done. **If enabling it surfaces a real violation, fix the violation — do not disable the
rule.** If it surfaces something you believe is a false positive, do not silence it silently:
report it with the code and your reasoning, and let the review adjudicate.

Prove the rule fires: introduce a deliberate missing dependency, watch lint go red, revert.

- [ ] **Step 7: Wire everything into CI, including the E2E stage** *(E2E carried from Task 13 review — REQUIRED)*

The E2E requirement, quoted from roadmap.md because it is the load-bearing one:

> `.github/workflows/ci.yml` today runs lint, typecheck, `pnpm test`, `pnpm test:integration` and
> `pnpm build`, and none of them renders a page. The Playwright suite is the **only** thing
> asserting that the CSP nonce reaches the HTML, that the enforcing policy does not break the
> page, and that the §2 header table survives on a real response — the assertions that separate
> `apps/web` from the twelve tasks before it. It passes on exactly one developer's Windows
> machine and nowhere else, so any of those can regress with CI still green.

Add to `.github/workflows/ci.yml`, after the build step:

```yaml
      - name: OpenAPI contract diff
        run: pnpm check:openapi

      - name: Tenant resource registry completeness
        run: pnpm check:registry
```

…plus the spec-coverage check, and an end-to-end stage: `pnpm exec playwright install --with-deps
chromium` (pin what you install; do not install all browsers) and `pnpm test:e2e`. Read
`apps/web/playwright.config.ts` first — it has a `webServer` block and a `start:e2e` script whose
env expectations (`WEB_PORT`, `APP_ENV=test`, a built `.next`) must hold on a Linux runner where
they have never run. Ordering matters: the E2E stage needs `pnpm build` to have happened, and the
CI job already copies `.env.example` to `.env` for the stack. Playwright traces/reports on
failure are worth uploading; a failing E2E stage with no artefact is a stage people disable.

Add to root `package.json`:

```json
"check:openapi": "node --experimental-strip-types scripts/check-openapi-diff.ts",
"check:registry": "node --experimental-strip-types scripts/check-tenant-registry.ts",
"check:specs": "node --experimental-strip-types scripts/check-vitest-projects.ts"
```

(Node is 26 here — bare `node script.ts` strips types without the flag. Use whichever you can
show working, and be consistent across the three.)

**You cannot run GitHub Actions locally, and must not claim the workflow passes.** What you can
do is run every command the workflow runs, on this machine, and report exactly that — including
whether Docker Desktop was running. Say which stages are verified by execution and which are
verified only by reading the YAML. The honesty rule in `CLAUDE.md` is not decoration on this
branch; eight instances of the false-claim class have been found on it so far, four of them
introduced while correcting another one.

- [ ] **Step 8: `pnpm format:check` — decide and close it** *(carried from Task 9)*

> `pnpm format:check` fails on 13 files and has ALWAYS failed; it is not one of the five gates and
> nothing in CI runs it. Task 14 owns the decision: wire it into CI and fix the files, or delete
> the script. Fixing the files without gating just lets it drift again.

**Ruling: wire it in and fix the files.** A formatter that has never passed is a broken window,
and the alternative — deleting `format`/`format:check` — throws away the only mechanical
consistency control the repo has. Run `pnpm format`, add a `Format` step to CI, and confirm
`pnpm format:check` exits 0.

Two guards on that, both checkable: `.prettierignore` deliberately exempts `apps/api/openapi.json`
(reformatting it breaks the byte-identity gate), `packages/ui/src/tokens.css` (transcribed
verbatim from the design system), `apps/web/next-env.d.ts`, and all `**/*.md`. Confirm the format
run did not touch them. And the 13 files include `packages/db/src/tenant-scope.ts` and
`tenant-client.ts` — the most security-critical files in the codebase. Prettier does not change
behaviour, but you must show it did not: `pnpm test` and `pnpm test:integration` green after the
reformat, and eyeball the diff for anything that is not whitespace.

Commit the reformat **separately** from the checks, so the review can read the real changes
without 13 files of whitespace on top of them.

- [ ] **Step 9: The missing root `dev` script**

`CLAUDE.md:55` and `.claude/development/setup.md:31,50-53` tell a developer to run `pnpm dev`,
`pnpm dev:web`, `pnpm dev:api` and `pnpm dev:worker`. None of them exists. `apps/web` has a `dev`
script; `apps/api` does not; the worker apps do not exist at all.

Documentation citing a command that does not run is the same defect class as a false claim.
Close it in whichever direction is honest: add the scripts that can genuinely work now (a root
`dev` via a `turbo` persistent task, and an `apps/api` dev script if you can get one working —
`tsc --watch` plus `node --watch dist/main.js`, or similar), and **correct `setup.md` and
`CLAUDE.md` to describe only what exists**, with the not-yet-real ones clearly marked as arriving
with their phase. Do not invent a `dev:worker` for apps that are not built.

Whatever you add, run it and show it starting. A `dev` script that was written but not started is
the thing this step exists to remove.

- [ ] **Step 10: Documentation, in the same change**

`CLAUDE.md`'s documentation rule: a `.claude/` document that this change makes wrong is a defect
in this change. At minimum consider `development/migrations.md` §5 (the new checks are what
enforce it), `security/tenant-isolation.md` (the FK-cascade rule now has a mechanical guard, and
its cascade wording has been wrong once before — restate it with the qualifier), and
`development/setup.md` / `CLAUDE.md` for Step 9.

**Do not update `.claude/product/roadmap.md`** — the controller owns that, after the review, so
the roadmap never claims a status the review has not granted.

**Cite sections you have actually opened and read.** The single most persistent defect class on
this branch is an invented or wrong `.claude/` section citation — eight instances, two of them
Criticals on Task 13 alone, and the audit that found the second was triggered by the fix for the
first. Every `§` you write, verify.

- [ ] **Step 11: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm check:openapi && pnpm check:registry && pnpm check:specs
pnpm format:check
pnpm test:integration   # Docker Desktop must be running
pnpm build
pnpm test:e2e
```

Commit in logical units (the reformat separate, per Step 8). Suggested message for the main
commit:

```
ci: OpenAPI contract diff, tenant registry completeness, and spec coverage

check:registry reads the Prisma DMMF and fails the build if any model
carrying organizationId is missing from TENANT_OWNED_MODELS — and also if a
registered model has lost the column, so the registry cannot go stale in
either direction. It additionally requires every model to be accounted for by
exactly one of tenant-owned, tenant root, or deliberately global, and rejects
any ON DELETE CASCADE into a tenant-owned table from a parent that is not
itself tenant-scoped — the exact shape of the defect Task 6 found live on
Membership.userId. This is what stops isolation coverage rotting: isolation
bugs do not appear in the code that was reviewed for isolation, they appear
in the table added six months later.

check:openapi fails if the committed schema drifts from what the contracts
generate, so an accidental breaking change is caught in review rather than by
a customer's pipeline.

check:specs fails if any *.spec.* file is claimed by zero Vitest projects or
by more than one. Task 12 hit three separate spellings of the silent-skip
trap, one of them introduced by the fix round for another.

CI gains an end-to-end stage, so the Playwright assertions covering the CSP
nonce and the security-header table stop depending on one developer's
machine.

All checks were verified by making them fail before making them pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

**Explicitly OUT of scope — deferred, do not do:**

- **Dead `packages/config/tsconfig/*` presets.** Assigned to Task 16 by the Task 9 review.
- **Redis `EVALSHA`/pipelining and `maxmemory-policy`.** Performance, not a CI check; Phase 3/4.
- **A guard against client-level `omit` on scope columns** (Task 6 residual). Evaluate it only if
  it is a one-rule ESLint addition you can prove fires; the gap fails **closed** and no
  constructed client uses that form. If it is not cheap, defer it to Task 16 and say so — do not
  spend the task on it.
- **`@RequirePermission()` enforcement.** Phase 2.

**Reporting requirements.** Write `task-14-report.md` beside this brief. Name every claim you
could not verify by execution, and every place you diverged from this brief and why. If a step
turns out to be wrong or impossible as written, say so and rule on it in the report rather than
quietly doing something else — the brief being wrong has happened before on this branch and
saying so is the correct outcome, not a failure.
