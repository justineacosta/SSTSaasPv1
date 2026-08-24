### Task 12: `packages/ui` — design tokens and base primitives

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/src/tokens.css`, `packages/ui/src/cn.ts`, `packages/ui/src/index.ts`
- Create: `packages/ui/src/components/{button,input,label,field,card,alert,badge,skeleton}.tsx`
- Test: `packages/ui/src/tokens.spec.ts`, `packages/ui/src/components/button.spec.tsx`, `packages/ui/src/components/field.spec.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `cn(...classes)`, and `Button`, `Input`, `Label`, `Field`, `Card`, `Alert`, `Badge`, `Skeleton` — each forwarding refs and accepting `className`

- [ ] **Step 1: Write the tokens**

`packages/ui/src/tokens.css`, transcribing `ui-ux/design-system.md` §2–3 and §5–6 exactly. Light
on bare `:root`; dark redefined under **both** guards, so the explicit toggle wins in both
directions and the system default works without one:

```css
@import 'tailwindcss';

:root {
  /* Neutrals — cool ink, not grey. Blue-shifted so the warm severity colours
     sit forward off the surface instead of merging into it. */
  --color-bg: #fbfcfd;
  --color-surface: #ffffff;
  --color-surface-raised: #f5f7f9;
  --color-border: #e3e8ee;
  --color-border-strong: #cbd3dd;
  --color-text: #0e1620;
  --color-text-muted: #5a6774;
  --color-text-subtle: #8494a3;

  /* Severity — the one place this product spends its colour budget.
     Critical is magenta-red, not pure red: pure red is spoken for by
     destructive actions, and a magenta-shifted critical stays distinguishable
     from high-orange under the common forms of colour vision deficiency,
     where red and orange collapse toward each other. */
  --color-severity-critical: #b4126b;
  --color-severity-critical-surface: #fdf0f6;
  --color-severity-high: #c2410c;
  --color-severity-high-surface: #fef3ec;
  --color-severity-medium: #a16207;
  --color-severity-medium-surface: #fdf7e7;
  --color-severity-low: #3d6e9e;
  --color-severity-low-surface: #eff5fa;
  --color-severity-info: #5a6774;
  --color-severity-info-surface: #f3f5f7;

  /* Status and intent. `accent` is deliberately the least interesting colour
     in the system: primary actions need to be findable, not loud. */
  --color-success: #0f7b4f;
  --color-warning: #a16207;
  --color-danger: #c0173a;
  --color-running: #3d6e9e;
  --color-accent: #1f4e7a;

  /* Type — a 1.2 ratio, tight, because density is the point. */
  --text-display: 30px;  --leading-display: 36px;
  --text-title: 24px;    --leading-title: 32px;
  --text-heading: 18px;  --leading-heading: 26px;
  --text-subhead: 15px;  --leading-subhead: 22px;
  --text-body: 14px;     --leading-body: 22px;
  --text-sm: 13px;       --leading-sm: 20px;
  --text-caption: 12px;  --leading-caption: 16px;
  --text-micro: 11px;    --leading-micro: 14px;

  /* Density. Row height, padding and font size move together; a dense table
     with body-size text is harder to scan, not easier. */
  --row-height-comfortable: 44px;
  --row-height-compact: 36px;
  --row-height-dense: 28px;

  /* Restrained radius; elevation carried by borders and background steps. */
  --radius-control: 4px;
  --radius-card: 6px;

  --duration-hover: 120ms;
  --duration-popover: 180ms;
  --duration-drawer: 240ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --color-bg: #0b0f14;
    --color-surface: #121820;
    --color-surface-raised: #1a222c;
    --color-border: #232d39;
    --color-border-strong: #33404f;
    --color-text: #e8edf3;
    --color-text-muted: #94a2b2;
    --color-text-subtle: #6b7987;

    --color-severity-critical: #f2569f;
    --color-severity-critical-surface: #2a0e1e;
    --color-severity-high: #fb923c;
    --color-severity-high-surface: #2a1408;
    --color-severity-medium: #e9b949;
    --color-severity-medium-surface: #251c06;
    --color-severity-low: #7daed6;
    --color-severity-low-surface: #0f1c27;
    --color-severity-info: #94a2b2;
    --color-severity-info-surface: #161c24;

    --color-success: #3fbe86;
    --color-warning: #e9b949;
    --color-danger: #f26b85;
    --color-running: #7daed6;
    --color-accent: #6fa3ce;
  }
}

/* Repeated verbatim so an explicit toggle wins over the system preference in
   both directions. CSS offers no way to alias one declaration block to two
   selectors, and a preprocessor is not worth adding for one duplication. */
:root[data-theme='dark'] {
  --color-bg: #0b0f14;
  --color-surface: #121820;
  --color-surface-raised: #1a222c;
  --color-border: #232d39;
  --color-border-strong: #33404f;
  --color-text: #e8edf3;
  --color-text-muted: #94a2b2;
  --color-text-subtle: #6b7987;

  --color-severity-critical: #f2569f;
  --color-severity-critical-surface: #2a0e1e;
  --color-severity-high: #fb923c;
  --color-severity-high-surface: #2a1408;
  --color-severity-medium: #e9b949;
  --color-severity-medium-surface: #251c06;
  --color-severity-low: #7daed6;
  --color-severity-low-surface: #0f1c27;
  --color-severity-info: #94a2b2;
  --color-severity-info-surface: #161c24;

  --color-success: #3fbe86;
  --color-warning: #e9b949;
  --color-danger: #f26b85;
  --color-running: #7daed6;
  --color-accent: #6fa3ce;
}

/* Tabular numerals everywhere: columns of scores, counts, durations and
   timestamps must align, or scanning down a column stops working. */
html { font-variant-numeric: tabular-nums; }

body {
  background-color: var(--color-bg);
  color: var(--color-text);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: Write the token test**

`packages/ui/src/tokens.spec.ts` parses the CSS and compares declared custom-property names per
block. This is a real test: a token defined only inside a media query is invisible to a viewer
on the system default, which is the most common way a theme silently breaks.

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return [...css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '').sort();
}

describe('design tokens', () => {
  const light = tokensIn(':root {');

  it('defines the full palette on bare :root, so nothing is dark-mode-only', () => {
    expect(light).toContain('--color-bg');
    expect(light).toContain('--color-text');
    expect(light).toContain('--color-accent');
  });

  it('defines all five severity accents and all five severity surfaces', () => {
    for (const level of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(light).toContain(`--color-severity-${level}`);
      expect(light).toContain(`--color-severity-${level}-surface`);
    }
  });

  it('redefines the dark palette under the system media query', () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('redefines the dark palette under the explicit toggle too', () => {
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('defines identical token sets in both dark blocks — a drift here is a theme bug', () => {
    expect(tokensIn(":root:not([data-theme='light'])")).toEqual(
      tokensIn(":root[data-theme='dark']"),
    );
  });

  it('defines every dark token in light as well, so no token exists in only one theme', () => {
    for (const token of tokensIn(":root[data-theme='dark']")) {
      expect(light, token).toContain(token);
    }
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('gives body an explicit background rather than inheriting the host', () => {
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*var\(--color-bg\)/);
  });
});
```

- [ ] **Step 3: Run the token test and verify it passes**

```bash
pnpm vitest run --project unit packages/ui
```
Expected: PASS, 8 tests. If the "identical token sets" assertion fails, one of the two dark
blocks is missing a token — fix the CSS, not the test.

- [ ] **Step 4: Write the primitives**

Each is a thin, `forwardRef`'d wrapper using tokens through Tailwind classes and **no raw hex**
(the lint rule from Task 1 enforces it). Two carry real behaviour:

`button.tsx` — variants `primary`, `secondary`, `ghost`, `danger`; sizes `sm`, `md`. Disabled
while pending, with a visible focus ring on `--color-accent`. Buttons name the outcome, so the
component takes children rather than a `label` prop, and the docblock says so:

```tsx
/**
 * Buttons name the outcome: "Start scan", "Generate report", "Revoke key" —
 * never "Submit", "OK", or "Confirm". The verb stays constant through the
 * flow, so the button that says "Start scan" produces a toast that says
 * "Scan started". See ui-ux/design-system.md §8.
 */
```

`field.tsx` — wires label, control, description, and error together with `aria-describedby` and
`aria-invalid`. A form error not programmatically tied to its input is invisible to a screen
reader, which is why this is a component rather than a convention.

`field.spec.tsx`:
```tsx
describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Organisation name"><input id="name" /></Field>);
    expect(screen.getByLabelText('Organisation name')).toBeInTheDocument();
  });

  it('ties the error message to the control with aria-describedby', () => {
    render(
      <Field label="Email" error="Enter a valid email address.">
        <input id="email" />
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Enter a valid email address.',
    );
  });

  it('marks the control invalid when there is an error', () => {
    render(<Field label="Email" error="Bad."><input id="email" /></Field>);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not mark the control invalid without an error', () => {
    render(<Field label="Email"><input id="email" /></Field>);
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
```

`button.spec.tsx`:
```tsx
describe('Button', () => {
  it('renders its children as the accessible name', () => {
    render(<Button>Start scan</Button>);
    expect(screen.getByRole('button', { name: 'Start scan' })).toBeInTheDocument();
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Start scan</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards a ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Start scan</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('uses no raw hex colour in its class output', () => {
    const { container } = render(<Button variant="danger">Revoke key</Button>);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
```

Add `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom`
as dev dependencies, and give `packages/ui` a `vitest.config.ts` setting
`environment: 'jsdom'` — the workspace default is `node`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): design tokens and base primitives

The full token set from ui-ux/design-system.md: the cool-ink neutral ramp,
the five-step severity ramp, status and intent, the 1.2 type scale, the three
density modes, and the motion durations.

Light is defined on bare :root; dark is redefined under both the
prefers-color-scheme media query and [data-theme="dark"], so the explicit
toggle wins in both directions and the system default works without one. A
test asserts the two dark blocks declare identical token sets and that no
token exists in only one theme — a token defined only inside a media query is
invisible to a viewer on the system default, which is how themes usually
break.

Eight primitives, no raw hex anywhere. Field ties label, description and
error together with aria-describedby, because an error not programmatically
tied to its input is invisible to a screen reader.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

