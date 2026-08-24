# Task 12 report: `packages/ui` — design tokens and base primitives

Status: **DONE**

## What I implemented

A new workspace package `@sentinel/ui`, following `packages/contracts`' structural
conventions (`package.json` with `build`/`typecheck`/`lint` scripts, `tsconfig.json` +
`tsconfig.build.json` split):

- `packages/ui/package.json`, `tsconfig.json`, `tsconfig.build.json`
- `packages/ui/src/tokens.css` — the full token set transcribed verbatim from
  `ui-ux/design-system.md` §2–3, §5–6
- `packages/ui/src/tokens.spec.ts` — the brief's structural CSS test, verbatim
- `packages/ui/src/cn.ts` — `cn(...classes)`, falsy-filtering class join
- `packages/ui/src/test-setup.ts` — registers jest-dom matchers and RTL's `afterEach(cleanup)`
- `packages/ui/src/components/{button,input,label,field,card,alert,badge,skeleton}.tsx`
- `packages/ui/src/components/button.spec.tsx`, `field.spec.tsx` — the brief's specs (one
  import changed; see Ruling 1/mechanical section below)
- `packages/ui/src/index.ts` — re-exports everything

Every primitive is a thin `forwardRef`'d wrapper accepting `className`, using
Tailwind arbitrary-value utilities that reference the CSS custom properties directly
(e.g. `bg-[var(--color-accent)]`, `rounded-[var(--radius-control)]`) — no `@theme` block,
no Tailwind config, no build in this package (Ruling 3).

`Button` takes `children` (never a `label` prop), carries the docblock from the brief
verbatim, and has a `pending` prop (`disabled = pending || disabled`, `aria-busy` when
pending) matching the brief's "disabled while pending" behaviour description — the brief's
own spec doesn't exercise this, but the brief's prose asks for it explicitly.

`Field` wires `label`/`children`/`description`/`error` via `cloneElement`, generating an id
with `useId()` when the child doesn't supply one, and computing `aria-describedby` from
whichever of description/error ids exist. `Field` forwards a ref to its wrapping `<div>`,
matching the brief's Interfaces line ("each forwarding refs and accepting className") — my
first draft missed this for `Field` (a plain function component) and I caught it in
self-review; see "Self-review findings" below.

### Mechanical/toolchain changes (Ruling 4)

- `packages/ui/tsconfig.json` adds `"lib": ["ES2023", "DOM", "DOM.Iterable"]` and
  `"jsx": "react-jsx"` locally — `tsconfig.base.json` is untouched.
- `eslint.config.js`: added `'**/*.spec.tsx'` to the spec-file exemption block (it only had
  `.spec.ts`, so `.spec.tsx` files were getting `no-restricted-imports`,
  `no-non-null-assertion`, and `no-restricted-properties` as hard errors — verified this
  empirically with `--print-config`, see Ruling 2 evidence below for the same technique
  applied to the raw-hex rule). The main rule block (custom rules, `no-console`, etc.) turned
  out to already apply to `.tsx` — flat-config objects with no `files` key apply to every file
  ESLint considers, and `typescript-eslint`'s own `eslint-recommended` sub-config already
  declares `files: ["**/*.ts","**/*.tsx", ...]`, which is what pulls `.tsx` into scope at all.
  I verified this with `--print-config` before assuming the gap the ruling described.
- `test-setup.ts` registers `@testing-library/jest-dom/vitest` and, separately,
  `afterEach(cleanup)` from `@testing-library/react`. The second import wasn't in the brief.
  Without it, `button.spec.tsx`'s "does not fire onClick while disabled" test and one of
  `field.spec.tsx`'s tests failed on first run — RTL's own auto-cleanup only self-registers
  against a *global* `afterEach`, and this workspace never enables `vitest`'s `globals: true`
  (every spec here imports `afterEach`/`describe`/etc. explicitly instead). Without cleanup,
  DOM from one test's `render()` was still mounted for the next test in the same file. Root
  cause and fix are recorded in a comment in `test-setup.ts`.
- React 19, `react-dom` 19, `@types/react`, `@types/react-dom`, `tailwindcss` — declared as
  both `peerDependencies` and `devDependencies` on `packages/ui`.

### One real bug found via typecheck, one fixed via a spec-file import change

- `field.tsx`'s `cloneElement` call didn't typecheck under `exactOptionalPropertyTypes: true`:
  a prop typed `'aria-describedby'?: string` rejects an *explicit* `undefined` value (as
  opposed to the key being absent). Fixed by widening the internal `ControllableProps` type to
  `string | undefined` etc. — this is a real, load-bearing type-safety catch from the shared
  base tsconfig, not cosmetic.
- `button.spec.tsx`'s `import userEvent from '@testing-library/user-event'` (the brief's
  literal code) doesn't typecheck here: under this repo's `moduleResolution: "nodenext"` +
  `verbatimModuleSyntax`, against `@testing-library/user-event`'s conditional exports map
  (which has no explicit `"import"` condition, only `"require"`/`"default"`), the default
  import types as the whole module namespace instead of the actual default export, so
  `userEvent.click` doesn't exist on the inferred type. I verified this concretely with an
  isolated probe file before changing anything (see the raw `tsc` errors and the probe in the
  session — not reproduced here to keep this report focused). The named import
  (`import { userEvent } from '@testing-library/user-event'`) is the exact same runtime object
  and types correctly. I changed the spec's import line only; the test's behaviour and
  assertions are untouched.

## What I tested, with results

### TDD evidence — tokens (brief Steps 1–3)

Wrote `tokens.css` (verbatim), then `tokens.spec.ts` (verbatim), then ran:

```
$ pnpm vitest run --project unit packages/ui
 ✓ unit  packages/ui/src/tokens.spec.ts (8 tests) 4ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

GREEN on first run — 8/8, matching the brief's "Expected: PASS, 8 tests."

### TDD evidence — primitives (brief Step 4)

Wrote `button.spec.tsx` and `field.spec.tsx` (verbatim from the brief) **before**
`button.tsx`/`field.tsx` existed, then ran them against the new `ui` vitest project:

RED:
```
$ pnpm vitest run --project ui
 FAIL  ui  packages/ui/src/components/button.spec.tsx
 Error: Failed to resolve import "./button.js" from ".../button.spec.tsx". Does the file exist?
 FAIL  ui  packages/ui/src/components/field.spec.tsx
 Error: Failed to resolve import "./field.js" from ".../field.spec.tsx". Does the file exist?
 Test Files  2 failed (2)
      Tests  no tests
```
This confirms the jsdom project itself is correctly wired (environment/setupFiles booted,
~800ms jsdom init) and the only reason for failure is the missing component files — not a
harness problem.

Implemented `label.tsx`, `button.tsx`, `field.tsx`. First re-run surfaced two real failures
(both cleanup-related, not implementation bugs — see mechanical section above) which I
diagnosed and fixed via `test-setup.ts`'s `afterEach(cleanup)`. After that fix:

GREEN:
```
$ pnpm vitest run --project ui --reporter=verbose
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > associates the label with the control
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > ties the error message to the control with aria-describedby
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > marks the control invalid when there is an error
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > does not mark the control invalid without an error
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > renders its children as the accessible name
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > does not fire onClick while disabled
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > forwards a ref to the underlying button element
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > uses no raw hex colour in its class output
 Test Files  2 passed (2)
      Tests  8 passed (8)
```

### Mutation checks (not just "the test exists")

Per the standing rule on this branch, before writing any sentence that a test "covers"
something, I broke the thing under test and confirmed the test actually fails:

- **Button "no raw hex" test**: temporarily changed `danger`'s `bg-[var(--color-danger)]` to
  `bg-[#c0173a]` in `button.tsx`, ran `pnpm vitest run --project ui .../button.spec.tsx` — the
  "uses no raw hex colour" test failed exactly as expected (`AssertionError: ... not to match
  /#[0-9a-f]{3,8}\b/i`), the other 3 tests stayed green. Reverted, confirmed 4/4 green again.
- **Field `aria-describedby` test**: temporarily deleted the `'aria-describedby': describedBy`
  line from `field.tsx`'s `cloneElement` call, ran the field spec — "ties the error message to
  the control with aria-describedby" failed (`expected undefined to be 'Enter a valid email
  address.'`), the other 3 stayed green. Reverted, confirmed 4/4 green again.

## Ruling 1 evidence — root `pnpm test` runs the .tsx specs, individual names shown

```
$ pnpm test
$ vitest run --project unit --project ui --passWithNoTests
...
 ✓ unit  packages/ui/src/tokens.spec.ts (8 tests) 7ms
...
 ✓ ui  packages/ui/src/components/field.spec.tsx (4 tests) 41ms
 ✓ ui  packages/ui/src/components/button.spec.tsx (4 tests) 133ms

 Test Files  24 passed (24)
      Tests  272 passed (272)
```

With `--reporter=verbose` against just the `ui` project, the individual test names:

```
$ pnpm vitest run --project ui --reporter=verbose
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > associates the label with the control
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > ties the error message to the control with aria-describedby
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > marks the control invalid when there is an error
 ✓ ui  packages/ui/src/components/field.spec.tsx > Field > does not mark the control invalid without an error
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > renders its children as the accessible name
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > does not fire onClick while disabled
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > forwards a ref to the underlying button element
 ✓ ui  packages/ui/src/components/button.spec.tsx > Button > uses no raw hex colour in its class output
```

Mechanism chosen: a new `ui` project in `vitest.workspace.ts` (`environment: 'jsdom'`,
`include: ['packages/ui/src/**/*.spec.tsx']`, `setupFiles: ['./packages/ui/src/test-setup.ts']`),
kept separate from `unit` rather than switching `unit` to jsdom, so every other package stays
on `environment: 'node'` and the jest-dom setup file isn't loaded for packages that never
installed the dependency. Root `package.json`'s `test` script became
`vitest run --project unit --project ui --passWithNoTests`.

`pnpm test:integration` still passes untouched (10 files, 139 tests, ran against real
Postgres via Testcontainers — Docker was up).

## Ruling 2 evidence — the no-raw-hex lint rule, built and proven to fire

`eslint.config.js` gained a new block using `no-restricted-syntax` (no custom plugin needed
— an AST selector against `Literal`/`TemplateElement` nodes matching a hex-colour regex),
scoped to `packages/ui/**/*.{ts,tsx}` and `apps/web/**/*.{ts,tsx}` (the latter inert until
Task 13 creates the directory).

Before this change, `--print-config` on `button.spec.tsx` showed no `no-restricted-syntax`
rule for hex colours at all — confirming the brief's claim that the rule genuinely didn't
exist yet.

Proof it fires — deliberately introduced a raw hex into `badge.tsx`:
```
$ sed -i "s/border-\[var(--color-border)\]/border-[#e3e8ee]/" packages/ui/src/components/badge.tsx
$ pnpm eslint packages/ui/src/components/badge.tsx

E:\GitHub\SSTSaasPv1\packages\ui\src\components\badge.tsx
  11:12  error  No raw hex colours — reference a design token custom property instead
                (e.g. bg-[var(--color-surface)]). See ui-ux/design-system.md §7  no-restricted-syntax

✖ 1 problem (1 error, 0 warnings)
```
Reverted, re-ran `pnpm eslint packages/ui/src/components/badge.tsx` — exit 0, clean.

**Documentation fix in the same commit (per the ruling):** grepped `.claude/` for other
claims about this rule. `ui-ux/design-system.md` §7's claim ("A lint rule enforces it") is now
true and needed no change. `.claude/development/coding-standards.md` §6 asserted "No raw hex
colours **or arbitrary spacing values** in components — tokens only" as a present-tense fact
under a non-"Not Implemented" status banner. Only the hex half is now true; I did not build
spacing enforcement (out of scope for this task and not requested by the brief or rulings), so
I narrowed that bullet to state exactly what's enforced today and flag spacing as not yet
lint-enforced, rather than leave a now-half-false claim standing.
`.claude/ui-ux/components.md` also mentions "no raw hex, no arbitrary spacing" but that whole
document is banner-marked "Status: Designed. Not Implemented," so its claim was already
correctly scoped as aspirational and I left it alone.

## Ruling 3 — class mechanism

Arbitrary-value utilities referencing the custom properties directly throughout (e.g.
`bg-[var(--color-accent)]`, `text-[length:var(--text-sm)]`, `rounded-[var(--radius-control)]`).
No `@theme` block, no Tailwind config file, no build step added to `packages/ui`. `tailwindcss`
is a `peerDependency` (plus `devDependency` for the type/CLI presence in this package's own
toolchain — it is never invoked here). `tokens.css` is exported from the package's `exports`
map (`"./tokens.css": "./src/tokens.css"`) for Task 13 to import into its own build pipeline.

## Full verification (brief Step 5)

Ran in order, on the whole repo (not just this package):

```
$ pnpm lint       → Tasks: 12 successful, 12 total
$ pnpm typecheck  → Tasks: 12 successful, 12 total
$ pnpm test       → Test Files 24 passed (24) / Tests 272 passed (272)
$ pnpm build      → Tasks: 7 successful, 7 total
```

Also ran `pnpm test:integration` (10 files, 139 tests, all passing) and
`pnpm format:check` — the latter flags 13 pre-existing files elsewhere in the repo (none of
them touched by this task) but nothing under `packages/ui/` or in `eslint.config.js`. I ran
`prettier --write` scoped only to the files I created/modified, and added
`packages/ui/src/tokens.css` to `.prettierignore` (matching the existing precedent for
`apps/api/openapi.json`) because Prettier would otherwise reformat the brief's paired
type-scale declarations onto separate lines, which is a real deviation from "ship it
verbatim" (Ruling 3).

Inspected `packages/ui/dist/` after `pnpm build`: declarations and `.js` emitted for every
source file, no `.spec.*` or `test-setup.ts` leaked into the build output.

## Files changed

New:
- `packages/ui/package.json`, `tsconfig.json`, `tsconfig.build.json`
- `packages/ui/src/tokens.css`, `tokens.spec.ts`, `cn.ts`, `index.ts`, `test-setup.ts`
- `packages/ui/src/components/{button,input,label,field,card,alert,badge,skeleton}.tsx`
- `packages/ui/src/components/button.spec.tsx`, `field.spec.tsx`

Modified:
- `vitest.workspace.ts` — new `ui` project (jsdom, its own setupFiles)
- `package.json` — root `test` script runs both `unit` and `ui` projects
- `eslint.config.js` — `.spec.tsx` added to the spec exemption glob; new no-raw-hex
  `no-restricted-syntax` block scoped to `packages/ui/**` and `apps/web/**`
- `.prettierignore` — `packages/ui/src/tokens.css` excluded (verbatim-transcription file)
- `.claude/development/coding-standards.md` — narrowed the now-partially-false raw-hex/spacing
  claim to what's actually enforced
- `pnpm-lock.yaml` — new dependencies

## Self-review findings

- **Field wasn't forwarding a ref** in my first draft — the brief's Interfaces line says all
  eight components forward refs and accept `className`; `Field` was a plain function component.
  Caught this on a second read of the brief's own contract, fixed by wrapping it in
  `forwardRef<HTMLDivElement, FieldProps>`, targeting the outer wrapping `div`. Re-ran
  typecheck and the full `ui` project after the fix — still green.
- **`Button`'s pending logic was wrong on first pass**: I initially wrote
  `disabled={disabled ?? pending}`, which means an explicit `disabled={false}` would silently
  override `pending={true}` and leave the button clickable — directly contradicting the
  brief's "disabled while pending" requirement. Fixed to `disabled={pending || disabled}` so
  `pending` always wins. Neither the brief's spec nor my own first read caught this; found it
  rereading my own code during self-review.
- Considered whether `Skeleton`'s `animate-pulse` conflicts with design-system.md §6's "exactly
  one ambient animation in the product" rule (the SSE-driven scan-progress pulse). Concluded
  it doesn't — that rule is about claims of live system state, not loading placeholders in
  general — but documented the reasoning directly in the component's docblock so the
  distinction is visible to whoever builds the actual scan-progress indicator later, and it's
  neutralised by `tokens.css`'s `prefers-reduced-motion` rule regardless.
- Chose not to touch `design-system.md`'s top-of-file "Not Implemented" status banner or
  `roadmap.md`. The rulings scoped my documentation obligation specifically to claims about
  the lint rule; broader status/roadmap updates follow the pattern visible in this branch's own
  history (a separate `docs(roadmap): ...` commit after a task lands), which isn't something
  this task's instructions asked me to do.
- Verified via `--print-config` (not assumption) both the pre-existing `.spec.tsx` exemption
  gap and the post-fix state, and did the same for the raw-hex rule actually firing — matching
  the standing instruction not to assert coverage without running it.

## Issues and concerns

- None that affect correctness. One judgment call worth flagging explicitly: I changed
  `button.spec.tsx`'s `userEvent` import from a default import (as literally written in the
  brief) to a named import, because the default import doesn't typecheck under this repo's
  module settings against this specific dependency version — verified with an isolated probe
  before making the change. The test's runtime behaviour and assertions are byte-for-byte the
  same; only the import statement differs.
- `pnpm format:check` (not part of the brief's mandated Step 5, and not previously clean on
  this branch) still fails on 13 pre-existing files outside this task's scope. I left those
  alone rather than reformatting code I didn't touch.

---

# Fix report — review round 1 (commit 784504c)

Independent review of `c1ca471` came back 0 Critical, 3 Important, 11 Minor. Nine Minors were
promoted into this round; two (#12 Badge severity variants without a glyph slot, #14
components.md/CLAUDE.md's "shadcn/ui based" claims) were explicitly deferred to the
whole-branch review and left untouched.

For each finding: what changed, the covering test, the command run, and its output.

## Important 1 — design-system.md §7 described the wrong mechanism

**Changed:** `.claude/ui-ux/design-system.md` §7 no longer says tokens are "consumed through
Tailwind theme extension." It now says they're consumed through Tailwind arbitrary-value
utilities (`bg-[var(--color-surface)]`), states plainly that `packages/ui` ships no `@theme`
block so named utilities like `bg-surface` do not exist, and tells whoever eventually builds
an `@theme` mapping to generate it from this file rather than hand-copy the token list. Also
rewrote the top-of-file status banner from "Direction defined. Not Implemented." to "Partially
Implemented," naming exactly what Task 12 shipped (tokens.css + eight primitives) versus what's
still Not Implemented (the rest of `components.md`'s inventory).

**Covering test:** none — this is documentation. Verified by rereading the new section against
Ruling 3's own text and against what `packages/ui` actually ships (checked the package's file
list — no tailwind config, no `@theme` anywhere in the tree).

**Command:** `git diff --cached -- .claude/ui-ux/design-system.md` (reproduced under "Files
changed" below).

## Important 2 — the 'ui' vitest project's glob was packages/ui-only

**Changed:** `vitest.workspace.ts`'s `ui` project `include` broadened from
`['packages/ui/src/**/*.spec.tsx']` to `['packages/*/src/**/*.spec.tsx',
'apps/*/src/**/*.spec.tsx']`.

**Verification before writing the comment claiming it works for apps/web:** created a
throwaway `apps/web/src/__probe__.spec.tsx` (not committed — deleted immediately after,
confirmed via `git status --short` showing no trace) asserting a jest-dom matcher
(`toBeInTheDocument`) against a raw DOM node, with no `@testing-library/react` involved (since
apps/web has no devDependencies of its own yet). Ran it through the broadened glob:

```
$ pnpm vitest run --project ui --reporter=verbose
 v ui  apps/web/src/__probe__.spec.tsx > apps/web probe (temporary, not committed) >
   runs under jsdom with jest-dom matchers available via packages/ui's setup file  5ms
 v ui  packages/ui/src/components/Field.spec.tsx > ... (4 tests)
 v ui  packages/ui/src/components/Button.spec.tsx > ... (4 tests)
 Test Files  3 passed (3)
      Tests  9 passed (9)
```

This confirms two things empirically, not by assumption: the broadened glob actually picks up
a spec outside `packages/ui`, and the shared `packages/ui/src/test-setup.ts` setupFiles path
resolves its own imports (`@testing-library/jest-dom/vitest`) against `packages/ui`'s
`node_modules` regardless of where the spec being run lives — because Node resolves a file's
bare imports against that file's own location, not the location of whichever spec triggered
it. Documented this directly in the comment above the `ui` project (see `vitest.workspace.ts`
diff) so Task 13 doesn't have to rediscover it. A real `apps/web` spec that imports
`@testing-library/react` directly will still need that as its own devDependency — noted in the
comment as Task 13's to add.

## Important 3 — filenames: renamed to PascalCase.tsx

**Changed:** all eight primitives and both spec files renamed via `git mv`:
`button.tsx to Button.tsx`, `input.tsx to Input.tsx`, `label.tsx to Label.tsx`,
`field.tsx to Field.tsx`, `card.tsx to Card.tsx`, `alert.tsx to Alert.tsx`,
`badge.tsx to Badge.tsx`, `skeleton.tsx to Skeleton.tsx`,
`button.spec.tsx to Button.spec.tsx`, `field.spec.tsx to Field.spec.tsx`. Updated every import
site: `index.ts` (all eight re-exports), `Field.tsx`'s import of `Label`, and both spec files'
import of their subject. `tsconfig.base.json`'s `forceConsistentCasingInFileNames: true` means
a mismatched-case import specifier is a build error, not just a style nit — confirmed clean
with `tsc -p packages/ui/tsconfig.json --noEmit` after the rename (exit 0).

Also added a new rule to `.claude/ui-ux/components.md` §4 (rule 8) recording that
shadcn-CLI-generated files must be renamed to `PascalCase.tsx` on generation, citing
`packages/ui`'s eight primitives as the precedent, so `apps/web` doesn't end up half-and-half
between conventions.

**Covering test:** the full `ui` project — every spec imports its subject by the new filename;
if any rename or import update were wrong, every test in that file would fail to even collect.

**Command and output:**
```
$ pnpm exec tsc -p packages/ui/tsconfig.json --noEmit
(exit 0, no output)

$ pnpm vitest run --project ui --reporter=verbose
 v ui  packages/ui/src/components/Field.spec.tsx (7 tests)
 v ui  packages/ui/src/components/Button.spec.tsx (4 tests)
 Test Files  2 passed (2)
      Tests  11 passed (11)
```

## Promoted Minor 4 — Field destroyed a child's own aria-describedby/aria-invalid

**Changed:** `Field.tsx`'s `describedBy` computation now merges
`children.props['aria-describedby']` in ahead of the generated description/error ids
(`[children.props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ')`)
instead of discarding it. `aria-invalid` is now only added to the `cloneElement` overrides
object when `error` is truthy (`if (error) { overrides['aria-invalid'] = true; }`) — previously
it was always set, to `true` or explicit `undefined`, and `cloneElement`'s explicit `undefined`
overwrites (not "clears") whatever the child already had.

**New tests** (`Field.spec.tsx`):
- `"preserves a control's own aria-describedby, merging in the description"` — a `<Field>`
  with a `description` wrapping an `<input>` that already declares
  `aria-describedby="pw-rules"` (pointing at a `<span id="pw-rules">` rendered as a sibling of
  `<Field>`, since `Field` only ever accepts one child). Asserts the final `aria-describedby`
  contains both `pw-rules` and Field's own generated description id, and that both resolve to
  the right text.
- `"leaves a control's own aria-invalid alone when there is no error"` — a `<Field>` with no
  `error`, wrapping an `<input aria-invalid="true">`. Asserts the attribute survives untouched.

**Mutation evidence — merge fix:**
```
$ pnpm vitest run --project ui packages/ui/src/components/Field.spec.tsx
```
Before (mutated back to the old `[descriptionId, errorId]`, dropping the child's own value):
```
 x Field > preserves a control's own aria-describedby, merging in the description  8ms
   -> expected [ 'password-description' ] to include 'pw-rules'
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```
After restoring the fix: `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

**Mutation evidence — aria-invalid fix:**
```
$ pnpm vitest run --project ui packages/ui/src/components/Field.spec.tsx
```
Before (mutated back to unconditional `overrides['aria-invalid'] = error ? true : undefined;`):
```
 x Field > leaves a control's own aria-invalid alone when there is no error  6ms
   -> expect(element).toHaveAttribute("aria-invalid", "true")
     Expected the element to have attribute: aria-invalid="true"
     Received: null
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```
After restoring the fix: `Test Files  1 passed (1)` / `Tests  7 passed (7)`. Each mutation was
applied, run, confirmed to fail exactly the targeted test with every other test still passing,
then reverted with `diff` confirming byte-identical restoration before moving on.

## Promoted Minor 5 — the useId() fallback branch had no test

**Changed:** added `"generates an id for a control that supplies none, still associating the
label"` to `Field.spec.tsx`, rendering `<Field label="Organisation name"><Input /></Field>`
using this package's own `Input` component (imported fresh into the spec) with no `id` prop —
exercising `controlId = children.props.id ?? generatedId` on the `?? generatedId` side, which
every brief-mandated spec had bypassed by always passing an explicit `id`.

**Mutation evidence:**
```
$ pnpm vitest run --project ui packages/ui/src/components/Field.spec.tsx
```
Before (mutated `const controlId = children.props.id ?? generatedId;` down to
`const controlId = children.props.id;`, deleting the fallback):
```
 x Field > generates an id for a control that supplies none, still associating the label  ...
   -> TestingLibraryElementError: Found a label with the text of: Organisation name, however
      no form control was found associated to that label.
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```
After restoring the fix: `Test Files  1 passed (1)` / `Tests  7 passed (7)`.

## Promoted Minor 6 — inconsistent isValidElement guard

**Changed:** removed the `isValidElement<ControllableProps>(children)` check and its `import`
entirely. `children.props.id` was already dereferenced unguarded five lines above where the
guard used to sit, so the guard was decorative — `FieldProps.children` is typed
`ReactElement<ControllableProps>` (not optional, not a union with non-element types), so
TypeScript already guarantees a valid element at every call site in this codebase; the runtime
check added no real protection it wasn't already skipping. `cloneElement(children, overrides)`
is now called directly.

**Covering test:** the full `Field` suite (7 tests) — `cloneElement` is on every code path
through `Field`, so a broken clone call fails every test that renders a `Field`, not just one.

**Command:** `pnpm exec tsc -p packages/ui/tsconfig.json --noEmit` -> exit 0 (confirms the
removed import doesn't leave an unused-import error, and that `cloneElement`'s type still
resolves without the narrowing) plus the full `ui` project run below.

## Promoted Minor 7 — `--text-sm` collides with Tailwind v4's own theme variable

**Investigated by actually compiling tokens.css**, not by reading Tailwind's source in the
abstract. Used `tailwindcss@4.3.3`'s own `compile()` API (the same version installed in this
repo) against `packages/ui/src/tokens.css` verbatim, requesting the utilities `text-sm`,
`text-body`, `bg-[var(--color-surface)]`, `aria-invalid:border-[var(--color-danger)]`.
Relevant excerpt of the compiled output:

```css
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
    --text-sm: 0.875rem;
    --text-sm--line-height: calc(1.25 / 0.875);
    /* ... */
  }
}
@layer utilities {
  .text-sm {
    font-size: var(--text-sm);
    line-height: var(--tw-leading, var(--text-sm--line-height));
  }
  /* ... */
}
:root {
  /* ... */
  --text-sm: 13px;
  --leading-sm: 20px;
  /* ... */
}
```

Confirmed: this file's `:root` block is **unlayered** CSS (it appears after `@layer utilities`
closes, with no `@layer` wrapper of its own), and unlayered CSS always wins the cascade over
anything inside any `@layer`, regardless of source order. So `--text-sm` resolves to `13px`
(this file's value) everywhere, including inside Tailwind's own `.text-sm` utility — but
`--text-sm--line-height` is untouched (this file only defines `--leading-sm`, a different
variable name Tailwind's `.text-sm` never reads), so the built-in `text-sm` utility ends up
`font-size: 13px` with Tailwind's own `line-height: calc(1.25 / 0.875)` (approx. 1.43), not
this design system's intended `20px`.

**Did not change the token value** (`--text-sm: 13px` is verbatim from design-system.md, the
authority) — documented the collision instead, in two places: a dedicated paragraph in
`design-system.md` §7 (quoted above in "Important 1"'s diff), and an inline comment on
`Button.tsx`'s `sizeClasses.sm` (the one place in the primitives that consumes `--text-sm`)
warning against ever reaching for the bare `text-sm`/`leading-sm` utilities.

**Full collision check, as requested — collisions and non-collisions both:** cross-referenced
every token name in `tokens.css` against `tailwindcss@4.3.3/theme.css`'s `--color-*`,
`--text-*`, `--radius-*`, `--ease-*`, and `--duration-*`-adjacent namespaces (grepped and
diffed the full palette/scale lists, reproduced in the design-system.md diff above):
- `--color-*`: no collision. This file's names (`bg`, `surface`, `surface-raised`, `border`,
  `border-strong`, `text`, `text-muted`, `text-subtle`, `severity-*`, `success`, `warning`,
  `danger`, `running`, `accent`) share nothing with Tailwind's palette names (`red`, `orange`,
  `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`,
  `violet`, `purple`, `fuchsia`, `pink`, `rose`, `slate`, `gray`, `zinc`, `neutral`, `stone`,
  `mauve`, `olive`, `mist`, `taupe`, `black`, `white`).
- `--text-*`: **one collision**, `--text-sm` (documented above). This file's other names
  (`display`, `title`, `heading`, `subhead`, `body`, `caption`, `micro`) don't match Tailwind's
  scale (`xs`, `sm`, `base`, `lg`, `xl`, `2xl` through `9xl`).
- `--radius-*`: no collision. `control`/`card` vs. Tailwind's `xs`/`sm`/`md`/`lg`/`xl`/`2xl`/
  `3xl`/`4xl` (and the separate deprecated bare `--radius`).
- `--ease-*`: no collision. `standard` vs. Tailwind's `in`/`out`/`in-out`.
- `--duration-*`: no collision — Tailwind v4 has no `--duration-*` theme namespace at all (only
  a singular `--default-transition-duration`), so `--duration-hover`/`-popover`/`-drawer` are
  never in Tailwind's way.
- `--leading-*`: no collision. `display`/`title`/`heading`/`subhead`/`body`/`sm`/`caption`/
  `micro` vs. Tailwind's `tight`/`snug`/`normal`/`relaxed`/`loose` — note `--leading-sm` itself
  does *not* collide (it's a different variable from `--text-sm--line-height`, which is the
  actual cause of Promoted Minor 7).
- `--row-height-*`: not a Tailwind namespace at all; no collision possible.

**Command used to compile and inspect (throwaway, not committed):**
```
$ node _probe_tw.mjs   # calls tailwindcss's compile() against tokens.css + a stub
                        # loadStylesheet resolving the bare 'tailwindcss' import
```
Output reproduced above. The probe script (`_probe_tw.mjs`) was deleted after use;
`git status --short` confirmed no trace before committing.

## Promoted Minor 8 — eslint.config.js comment implied CSS was in scope

**Changed:** the comment above the no-raw-hex `no-restricted-syntax` block now says the rule
"only ever sees TypeScript/TSX" and that "ESLint does not lint CSS at all — tokens.css's hex
values ... are outside its reach entirely, not 'exempted' by anything written here," replacing
the old "tokens.css itself is exempt" phrasing that implied ESLint was choosing not to flag it.

**Covering test:** none needed — it's a comment; the rule's actual `files` glob
(`*.{ts,tsx}`) was unchanged and re-verified still fires/doesn't-fire correctly (see the
`ui:lint` run in the full verification below).

## Promoted Minor 9 — cn.ts's docblock made a false causal claim

**Changed:** reworded from "callers append their own className last, so an override wins by
CSS source order" to state plainly that appending last in the *string* has no bearing on which
rule wins — two same-specificity Tailwind utilities are resolved by their order in the
*compiled stylesheet*, which the caller doesn't control — and that a caller's override "may see
no effect at all" without `tailwind-merge`.

**Covering test:** none — docblock only; `cn`'s actual behaviour (dependency-free string join,
already covered indirectly by every component spec that renders a `className`) is unchanged.

## Promoted Minor 10 — type scale applied only in Label.tsx

**Changed:** paired every remaining bare `text-[length:var(--text-*)]` with its matching
`leading-[var(--leading-*)]`:
- `Button.tsx` `sizeClasses.sm` and `.md`
- `Input.tsx`'s single className string
- `Alert.tsx`'s base className
- `Badge.tsx`'s base className
- `Field.tsx`'s description `<p>` and error `<p>`

Also gave `Input.tsx` `h-[var(--row-height-compact)]` (matching `Button`'s `md` size height) so
an `Input` and a `Button` placed side by side line up, addressing the related note in the same
finding.

**Covering test:** `Field.spec.tsx` and `Button.spec.tsx` render these exact classNames (the
"no raw hex" test asserts on `Button`'s full rendered `innerHTML`, which now includes the
`leading-*` classes) — confirmed via the full `ui` project run below that nothing broke.
No new dedicated test was written for the pairing itself (it's a class-string change, not new
branching behaviour) — this matches the coordinator's explicit scope: "Findings 4 and 5 need
new tests," not this one.

## Promoted Minor 11 — Alert's role always defaulted to 'status'

**Changed:** `Alert.tsx` no longer defaults `role` to a static `'status'`. It now computes
`resolvedRole = role ?? (variant === 'danger' ? 'alert' : 'status')` — an explicit `role` prop
still wins outright, `danger` gets the assertive `'alert'` role, every other variant keeps
`'status'`.

**Covering test:** none new (not requested for this finding); verified by reading the compiled
output and by `tsc` — `role` is now `string | undefined` from `HTMLAttributes`, narrowed
correctly by the `??` fallback. Confirmed via `pnpm exec tsc -p packages/ui/tsconfig.json
--noEmit` (exit 0) and the full `ui` project run below (Alert isn't itself spec'd by the brief,
so no spec exercises it directly, matching Card/Input/Skeleton — only Button and Field have
brief-mandated specs).

## Promoted Minor 13 — Ruling 1 evidence, closed with one command

**Command:**
```
$ pnpm test --reporter=verbose
```
(No separate `--project ui` invocation — this is the literal root `pnpm test`, extended with
`--reporter=verbose`, which `pnpm` forwards straight through to the underlying
`vitest run --project unit --project ui --passWithNoTests` script.)

**Output (tail, ANSI stripped):**
```
 v  unit  apps/api/src/app-setup.spec.ts > configureApp middleware pipeline > establishes the request ID before the security headers are written 3ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > associates the label with the control 23ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > ties the error message to the control with aria-describedby 3ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > marks the control invalid when there is an error 2ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > does not mark the control invalid without an error 2ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > preserves a control's own aria-describedby, merging in the description 3ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > leaves a control's own aria-invalid alone when there is no error 2ms
 v  ui  packages/ui/src/components/Field.spec.tsx > Field > generates an id for a control that supplies none, still associating the label 1ms
 v  ui  packages/ui/src/components/Button.spec.tsx > Button > renders its children as the accessible name 55ms
 v  ui  packages/ui/src/components/Button.spec.tsx > Button > does not fire onClick while disabled 61ms
 v  ui  packages/ui/src/components/Button.spec.tsx > Button > forwards a ref to the underlying button element 2ms
 v  ui  packages/ui/src/components/Button.spec.tsx > Button > uses no raw hex colour in its class output 2ms

 Test Files  24 passed (24)
      Tests  275 passed (275)
   Start at  17:05:53
   Duration  2.50s (transform 1.48s, setup 340ms, collect 7.65s, tests 1.08s, environment 970ms, prepare 3.54s)
```
Every `.tsx` test name (7 Field + 4 Button = 11) is visible in a single root `pnpm test`
invocation's own output — no second command, no separate `--project ui` run needed to see the
names. 275 total (up from 272 in the original submission: 3 new Field tests; integration tests
are a separate project/command, unaffected).

## Deferred — left untouched, noted where I came close

- **#12 (Badge severity variants, no glyph slot):** `Badge.tsx` was touched in this round
  (Promoted Minor 10, pairing `leading-[var(--leading-caption)]`), but its `variantClasses`
  colour mapping and lack of a glyph/icon slot are unchanged. Not addressed here.
- **#14 (`components.md`/`CLAUDE.md`'s "shadcn/ui based" claims):** `components.md` was
  touched in this round (the new PascalCase rule, item 8 in §4, which itself mentions "the
  shadcn CLI" in passing), but the existing §1 line "shadcn/ui based, restyled to the tokens in
  design-system.md" (the actual claim under review) is untouched, and `CLAUDE.md`'s stack table
  entry for shadcn/ui was not opened at all.

## Full verification, after all fixes

```
$ pnpm lint        -> Tasks: 12 successful, 12 total
$ pnpm typecheck   -> Tasks: 12 successful, 12 total
$ pnpm build       -> Tasks: 7 successful, 7 total
$ pnpm test:integration -> Test Files 10 passed (10) / Tests 139 passed (139)
$ pnpm test --reporter=verbose -> Test Files 24 passed (24) / Tests 275 passed (275)
```

## Files changed (this round)

- `.claude/ui-ux/design-system.md` — §7 mechanism correction + `--text-sm` collision
  documentation; top status banner
- `.claude/ui-ux/components.md` — new rule 8 (PascalCase filenames, shadcn CLI renaming)
- `eslint.config.js` — reworded the no-raw-hex block's comment (CSS-out-of-scope clarification)
- `vitest.workspace.ts` — broadened the `ui` project's glob to `packages/*` and `apps/*`
- `packages/ui/src/cn.ts` — reworded docblock (dropped the false causal claim)
- `packages/ui/src/components/{button,input,label,field,card,alert,badge,skeleton}.tsx` -->
  renamed to `PascalCase.tsx`
- `packages/ui/src/components/{button,field}.spec.tsx` --> renamed to `PascalCase.spec.tsx`
- `packages/ui/src/components/Field.tsx` — aria-describedby/aria-invalid merge fix, guard
  removal, leading-* pairing on both `<p>` elements
- `packages/ui/src/components/Field.spec.tsx` — three new tests
- `packages/ui/src/components/Button.tsx` — leading-* pairing, `--text-sm` collision comment
- `packages/ui/src/components/Input.tsx` — leading-* pairing, matching height
- `packages/ui/src/components/Alert.tsx` — leading-* pairing, role-by-variant
- `packages/ui/src/components/Badge.tsx` — leading-* pairing
- `packages/ui/src/index.ts` — updated import paths for the renamed files

## Concerns after this round

None that affect correctness. The two deferred findings are real and left open deliberately,
per instruction, for the whole-branch review.

---

# Fix report — review round 2 (commit 2b0f9ce)

Re-review of `c1ca471..784504c` came back 12/12 round-1 findings ADDRESSED, 0 Critical, 0
Important. Three new Minors came out of the fix itself. All three fixed below.

## Finding 1 — Button.tsx's round-1 comment contained a false claim

**What I checked in theme.css before writing the replacement wording:**
```
$ grep -n "\-\-leading" node_modules/.pnpm/tailwindcss@4.3.3/node_modules/tailwindcss/theme.css
391:  --leading-tight: 1.25;
392:  --leading-snug: 1.375;
393:  --leading-normal: 1.5;
394:  --leading-relaxed: 1.625;
395:  --leading-loose: 2;
```
Confirmed: Tailwind v4's `--leading-*` theme namespace has exactly five names —
`tight`/`snug`/`normal`/`relaxed`/`loose` — no `sm`. Tailwind only generates a named
`leading-<key>` utility for a key that exists in this namespace (or a bare numeric value via
a different mechanism entirely), so `leading-sm` corresponds to nothing and generates no CSS
rule at all. It does not "follow Tailwind's own line-height default" — there is no default for
it to follow, because the utility itself doesn't exist.

**Changed:**
- `Button.tsx`'s comment on `sizeClasses.sm`: replaced "never through the bare
  `text-sm`/`leading-sm` utilities, which follow Tailwind's own 0.875rem/line-height default"
  with a claim scoped correctly to each: `text-sm` is real and would silently take this file's
  13px while keeping Tailwind's own line-height ratio (still true, unchanged from round 1);
  `leading-sm` isn't a Tailwind utility at all, so it generates no CSS and silently no-ops.
- `design-system.md` §7's echo ("Do not use the bare `text-sm`/`leading-sm` utilities") was
  reworded the same way, and the sentence now also names the `--leading-*`, `--duration-*`, and
  `--row-height-*` namespaces the round-1 collision check actually covered but the prose never
  enumerated (the re-review's own diff intersected all 48 token names against all 419 theme
  variable names and reproduced this exact set — I checked it, didn't just take the number).

**Covering test:** none — prose/comment only. `pnpm exec tsc -p packages/ui/tsconfig.json
--noEmit` confirms the comment change didn't touch any code path (exit 0, reproduced below).

## Finding 2 — the broadened 'ui' glob had no exclude counterpart

**Changed:** `vitest.workspace.ts`'s `ui` project gained
`exclude: ['**/*.integration.spec.tsx']`, mirroring the `unit` project's
`exclude: ['**/*.integration.spec.ts']` at line 8.

**Verified, not assumed:** created a throwaway
`apps/web/src/__probe__.integration.spec.tsx` (deleted immediately after; confirmed via
`git status --short` showing no trace before committing) and ran it against each project:

```
$ pnpm vitest run --project ui --reporter=verbose | grep -i probe
(no output — correctly excluded from 'ui')

$ pnpm vitest run --project unit --reporter=verbose | grep -i probe
(no output — 'unit' only matches *.spec.ts, never matched .tsx to begin with)

$ pnpm vitest run --project integration --reporter=verbose | grep -i probe
(no output — 'integration'’s include is *.integration.spec.ts, .ts-only, doesn't match .tsx)
```

**Residual gap, flagged rather than silently fixed or silently left:** the exclude does what
it was asked to do — a `*.integration.spec.tsx` no longer runs under `ui`'s jsdom/no-timeout
constraints. But because the `integration` project's own `include` is `.ts`-only, such a file
now matches *no project at all* rather than running in the wrong one — the same
"green while executing nothing" shape Ruling 1 exists to rule out, just one level further out.
Widening `integration`'s include to also accept `.tsx` (and, if a real one is ever written,
almost certainly giving it `environment: 'jsdom'` too) wasn't part of the three findings this
round, and the round was described as small and specific, so I didn't take it — flagging it
here for a decision rather than either quietly expanding scope or quietly leaving it
undocumented.

## Finding 3 — Alert's role-by-variant behaviour had no test

**Changed:** created `packages/ui/src/components/Alert.spec.tsx` (no such file existed before
— `Alert` wasn't one of the two brief-mandated spec files) with three tests:
- `"announces as the assertive role for the danger variant"` — `<Alert variant="danger">`
  resolves via `getByRole('alert')`.
- `"announces as the polite status role for a non-danger variant"` — `<Alert variant="success">`
  resolves via `getByRole('status')`.
- `"lets an explicit role override the variant default"` — `<Alert variant="danger"
  role="status">` resolves via `getByRole('status')` and asserts `queryByRole('alert')` finds
  nothing.

**Mutation evidence:**
```
$ pnpm vitest run --project ui packages/ui/src/components/Alert.spec.tsx
```
Before (mutated `resolvedRole = role ?? (variant === 'danger' ? 'alert' : 'status')` down to
the old unconditional `role ?? 'status'`):
```
 x Alert > announces as the assertive role for the danger variant
   -> Unable to find an accessible element with the role "alert"
      (rendered element has role="status" instead)
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```
The other two tests stayed green — the "non-danger announces status" test trivially still
passed under the mutation (both branches say 'status' for non-danger), and "explicit role
wins" also still passed (an explicit prop was never touched by the mutation), which is exactly
the coherent, narrow failure a correct mutation should produce here — not every test breaking,
just the one the fix actually changed.

After restoring the fix (`diff` confirmed byte-identical restoration):
```
$ pnpm vitest run --project ui packages/ui/src/components/Alert.spec.tsx
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

## Full verification, after all three fixes

```
$ pnpm exec tsc -p packages/ui/tsconfig.json --noEmit
(exit 0, no output)

$ pnpm lint       -> Tasks: 12 successful, 12 total
$ pnpm typecheck  -> Tasks: 12 successful, 12 total
$ pnpm build      -> Tasks: 7 successful, 7 total
$ pnpm test:integration -> Test Files 10 passed (10) / Tests 139 passed (139)
```

`pnpm test --reporter=verbose` (root command, tail):
```
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > associates the label with the control 25ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > ties the error message to the control with aria-describedby 4ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > marks the control invalid when there is an error 2ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > does not mark the control invalid without an error 2ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > preserves a control's own aria-describedby, merging in the description 3ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > leaves a control's own aria-invalid alone when there is no error 1ms
 ✓  ui  packages/ui/src/components/Field.spec.tsx > Field > generates an id for a control that supplies none, still associating the label 1ms
 ✓  ui  packages/ui/src/components/Alert.spec.tsx > Alert > announces as the assertive role for the danger variant 48ms
 ✓  ui  packages/ui/src/components/Alert.spec.tsx > Alert > announces as the polite status role for a non-danger variant 3ms
 ✓  ui  packages/ui/src/components/Alert.spec.tsx > Alert > lets an explicit role override the variant default 3ms
 ✓  ui  packages/ui/src/components/Button.spec.tsx > Button > renders its children as the accessible name 59ms
 ✓  ui  packages/ui/src/components/Button.spec.tsx > Button > does not fire onClick while disabled 69ms
 ✓  ui  packages/ui/src/components/Button.spec.tsx > Button > forwards a ref to the underlying button element 2ms
 ✓  ui  packages/ui/src/components/Button.spec.tsx > Button > uses no raw hex colour in its class output 2ms

 Test Files  25 passed (25)
      Tests  278 passed (278)
   Start at  20:53:29
   Duration  2.57s (transform 1.04s, setup 554ms, collect 6.90s, tests 1.16s, environment 1.60s, prepare 3.40s)
```
278 total, up from 275 (three new Alert tests).

## Files changed (this round)

- `.claude/ui-ux/design-system.md` — corrected the leading-sm claim, enumerated the checked
  namespaces
- `packages/ui/src/components/Button.tsx` — corrected the same claim in its comment
- `vitest.workspace.ts` — added `exclude: ['**/*.integration.spec.tsx']` to the `ui` project
- `packages/ui/src/components/Alert.spec.tsx` — new, three tests

## Concerns after this round

One residual gap, deliberately not fixed, flagged above under Finding 2: a future
`*.integration.spec.tsx` currently matches no vitest project at all (silent, not wrong-project).
Scoped out of this round; the coordinator's call on whether it needs its own round or waits for
Task 13, which will touch this file anyway when it adds `apps/web`.

---

# Fix report — review round 3 (commit 0621e54)

The coordinator confirmed the round-2 residual directly (`vitest.workspace.ts:17`) and traced
it to round 2's own `exclude` on the `ui` project: a `*.integration.spec.tsx` now matched no
project at all. One-line fix, as scoped.

## The fix

`vitest.workspace.ts`'s `integration` project include widened from
`['packages/*/src/**/*.integration.spec.ts', 'apps/*/src/**/*.integration.spec.ts']` to
`['packages/*/src/**/*.integration.spec.{ts,tsx}', 'apps/*/src/**/*.integration.spec.{ts,tsx}']`.
`environment` stays `'node'` — not changed to `'jsdom'`, per instruction: nothing under this
project needs a DOM today, and a `.tsx` integration spec that did will now fail loudly (no
`document` global) rather than silently not running at all, which is the correct direction to
fail in until a real one exists to say what it actually needs.

## Point 2 — checked the `unit` project's exclude, not assumed

`unit`'s `include` (`vitest.workspace.ts:7`) is `['packages/*/src/**/*.spec.ts',
'apps/*/src/**/*.spec.ts', 'scripts/**/*.spec.ts']` — every pattern ends in the literal
`.spec.ts`, never `.tsx`. A file named `*.integration.spec.tsx` has a `.tsx` extension, so it
was never matched by `unit`'s include to begin with, independent of its
`exclude: ['**/*.integration.spec.ts']` at line 8 (which is itself `.ts`-only and also never
touches a `.tsx` file). Reading the glob is enough to establish this, but confirmed it
empirically anyway rather than asserting it from the pattern alone:

```
$ mkdir -p apps/web/src
$ cat > apps/web/src/__probe__.integration.spec.tsx   # trivial passing test, not committed

$ pnpm vitest run --project unit --reporter=verbose | grep -i "__probe__"
NOT MATCHED by unit

$ pnpm vitest run --project ui --reporter=verbose | grep -i "__probe__"
NOT MATCHED by ui

$ pnpm vitest run --project integration --reporter=verbose | grep -i "__probe__"
 ✓  integration  apps/web/src/__probe__.integration.spec.tsx > probe (temporary, not committed) > lands somewhere exactly once  1ms
```

Confirms the file now lands in exactly one project — `integration` — and nowhere else. Probe
file deleted immediately after (along with the now-empty `apps/web/` it created);
`git status --short` showed no trace before committing.

## Full verification, after the fix

```
$ pnpm lint       -> Tasks: 12 successful, 12 total
$ pnpm typecheck  -> Tasks: 12 successful, 12 total
$ pnpm build      -> Tasks: 7 successful, 7 total
$ pnpm test:integration -> Test Files 10 passed (10) / Tests 139 passed (139)  (unaffected — no
                           real *.integration.spec.tsx exists yet)
$ pnpm test --reporter=verbose
 Test Files  25 passed (25)
      Tests  278 passed (278)
   Start at  20:57:04
   Duration  4.22s (transform 2.51s, setup 544ms, collect 9.75s, tests 1.31s, environment 1.71s, prepare 8.54s)
```
Same 25 files / 278 tests as round 2 — this fix has no effect on any spec that exists in the
repo today; it only changes where a `*.integration.spec.tsx` would land once one is written.

## Files changed (this round)

- `vitest.workspace.ts` — `integration` project's `include` widened to `.{ts,tsx}`

## Not built, on instruction

The general guard (every `*.spec.*` claimed by exactly one project) — deferred to Task 14
alongside the tenant-registry completeness check, per the coordinator's explicit note.

## Concerns after this round

None. No residual gap identified.
