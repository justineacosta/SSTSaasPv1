# Design system

> **Status: Partially Implemented.** Tokens (`packages/ui/src/tokens.css`) and eight base
> primitives — Button, Input, Label, Field, Card, Alert, Badge, Skeleton — shipped in
> `packages/ui` (Task 12). The full primitive/pattern/domain-component inventory in
> [`components.md`](components.md) is Not Implemented; those land alongside the features
> that need them.

## 1. Design thesis

**The interface is quiet so the findings can be loud.**

Marcus spends his working day in a triage queue. Priya spends hers writing up evidence.
Neither needs an interface with opinions. In a findings table, the single most important
signal is severity — and severity is communicated by colour. If the chrome around it is also
saturated, severity stops meaning anything, and the user loses the one visual channel that
was doing real work.

So this product spends its colour budget in exactly one place. Chrome, navigation, surfaces,
and typography are near-neutral ink tones. **Saturated colour is reserved for severity,
status, and destructive intent, and appears nowhere else** — not in the logo lockup within
the app, not in empty-state illustrations, not in chart defaults, not in a hero gradient.

This is a real constraint with real costs. It rules out the dark-terminal-with-neon-accent
look that most security products adopt, which is a shame because it is fun, and it is also
precisely why everything in that category looks alarming at 4pm on a Thursday when nothing is
wrong. We are building an instrument, not a war room.

## 2. Typeface system

The material of this product is HTTP traffic, TLS parameters, CVSS vectors, and code
locations. Monospace here is not a stylistic gesture; it is the substance. The type system is
therefore built around a family designed as a coordinated set with a monospace sibling, so
that switching between prose and payload is a change of voice rather than a change of world.

| Role | Face | Use |
|---|---|---|
| Display | **IBM Plex Sans Condensed**, 600 | Page titles, table headers, metric labels, nav sections |
| Body | **IBM Plex Sans**, 400/500 | All prose, form labels, descriptions, buttons |
| Data | **IBM Plex Mono**, 400/500 | Evidence, HTTP captures, CVSS vectors, fingerprints, IDs, code, CLI, counts in tables |
| Fallbacks | `ui-sans-serif, system-ui` / `ui-monospace, SFMono-Regular, Menlo` | Always specified |

IBM Plex was drawn for engineering and instrumentation contexts and carries a slight
mechanical stiffness that suits a measurement tool. The condensed cut earns its place
functionally: a findings table has eight or nine meaningful columns, and condensed headers buy
horizontal room that Inter or system-ui simply do not.

**Numerals are tabular everywhere.** `font-variant-numeric: tabular-nums` on every count,
score, duration, and timestamp, so columns of numbers align and scanning down a column works.

### Scale

A 1.2 ratio — tight, because density is the point. Line height loosens as size drops.

| Token | Size / line-height | Use |
|---|---|---|
| `text-display` | 30 / 36 | Page title only |
| `text-title` | 24 / 32 | Section title |
| `text-heading` | 18 / 26 | Card and panel heading |
| `text-subhead` | 15 / 22 | Sub-section, emphasised body |
| `text-body` | 14 / 22 | Default |
| `text-sm` | 13 / 20 | Table cells, secondary text |
| `text-caption` | 12 / 16 | Metadata, timestamps, helper text |
| `text-micro` | 11 / 14 | Eyebrows, table headers (uppercase, `0.06em` tracking) |

## 3. Colour

### Neutrals — cool ink, not grey

The neutral ramp is blue-shifted rather than pure grey. It reads as instrumentation, and more
usefully it makes the warm severity colours sit forward off the surface instead of merging
into it.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#FBFCFD` | `#0B0F14` | Page background |
| `surface` | `#FFFFFF` | `#121820` | Cards, tables, panels |
| `surface-raised` | `#F5F7F9` | `#1A222C` | Headers, toolbars, hover |
| `border` | `#E3E8EE` | `#232D39` | Default border |
| `border-strong` | `#CBD3DD` | `#33404F` | Emphasised divider, input border |
| `text` | `#0E1620` | `#E8EDF3` | Primary text |
| `text-muted` | `#5A6774` | `#94A2B2` | Secondary text |
| `text-subtle` | `#8494A3` | `#6B7987` | Metadata, placeholders |

### Severity — the ramp that carries the meaning

Five ordered steps. The ramp rotates hue *and* drops chroma as severity falls, so it reads as
a gradient of urgency rather than five unrelated labels. Every value is tested for 4.5:1
against its paired surface in both themes.

| Severity | Accent (light / dark) | Surface tint | Glyph |
|---|---|---|---|
| **Critical** | `#B4126B` / `#F2569F` | `#FDF0F6` / `#2A0E1E` | ◆ filled diamond |
| **High** | `#C2410C` / `#FB923C` | `#FEF3EC` / `#2A1408` | ▲ filled triangle |
| **Medium** | `#A16207` / `#E9B949` | `#FDF7E7` / `#251C06` | ● filled circle |
| **Low** | `#3D6E9E` / `#7DAED6` | `#EFF5FA` / `#0F1C27` | ○ hollow circle |
| **Info** | `#5A6774` / `#94A2B2` | `#F3F5F7` / `#161C24` | — dash |

Critical is magenta-red rather than pure red. Two reasons: pure red is already spoken for by
destructive actions, and a magenta-shifted critical remains distinguishable from high-orange
under the most common forms of colour vision deficiency, where red and orange collapse toward
each other.

**Severity is never communicated by colour alone.** Every severity indicator carries the
glyph and the text label. This is a WCAG requirement and it is also how the product stays
readable in a printed report, a screenshot pasted into Slack, and a greyscale PDF.

### Status and intent

| Token | Value (light / dark) | Use |
|---|---|---|
| `success` | `#0F7B4F` / `#3FBE86` | Resolved, passed retest, healthy |
| `warning` | `#A16207` / `#E9B949` | Approaching limit, degraded, expiring |
| `danger` | `#C0173A` / `#F26B85` | Destructive actions, failures |
| `running` | `#3D6E9E` / `#7DAED6` | Scan in progress, pending |
| `accent` | `#1F4E7A` / `#6FA3CE` | Primary buttons, links, focus |

`accent` is a deep, desaturated slate blue — deliberately the least interesting colour in the
system. Primary actions need to be findable, not loud.

## 4. Signature element — the severity spine

Every findings list renders a **2px vertical rule at the left edge of each row**, coloured by
severity, with a small notch mark at the row's vertical centre whose position encodes
confidence (high = full height, medium = two-thirds, low = one-third).

Read at speed down a list of forty findings, the spine forms a legible waterfall: you see the
shape of the queue — where the critical cluster sits, how much of it is low-confidence noise —
before reading a single word. It replaces the severity pill that would otherwise occupy a
column, and it survives dense mode where pills would not.

This is the one place the design is willing to be inventive, and it is inventive in service of
scanning speed rather than decoration. Everything else stays disciplined.

## 5. Layout and density

8px base grid. Application content is capped at 1600px; evidence and report views run full
width because HTTP captures are wide by nature.

Three density modes, persisted per user: **comfortable** (44px rows), **compact** (36px,
default for tables), **dense** (28px, for triage sessions). Density changes row height,
padding, and font size together — it does not just squeeze whitespace, because a dense table
with body-size text is harder to scan, not easier.

Radius is restrained: `4px` on inputs and buttons, `6px` on cards, `0` on table cells.
Elevation is carried by borders and background steps rather than shadows; shadow appears only
on genuinely floating surfaces — dialogs, popovers, dropdowns.

## 6. Motion

Motion exists to explain state change and nothing else. Durations: 120ms for hover and focus,
180ms for popovers and toasts, 240ms for drawers and dialogs. Easing `cubic-bezier(0.2, 0, 0,
1)`.

There is exactly one ambient animation in the product: the scan-progress indicator, which
pulses while a scan is genuinely running and stops the instant the stream reports otherwise.
It is driven by real SSE events — **never by a timer**. A progress animation that continues
after the backend has stopped reporting is the interface lying about system state, and in a
security tool that is a defect, not a polish issue.

`prefers-reduced-motion: reduce` removes all transitions and replaces the progress pulse with
a static determinate bar.

## 7. Tokens

Tokens are CSS custom properties on `:root`, consumed through Tailwind **arbitrary-value**
utilities that reference the custom property directly — `bg-[var(--color-surface)]`,
`text-[length:var(--text-body)]`, `rounded-[var(--radius-control)]`. `packages/ui` ships no
`@theme` block, so named utilities like `bg-surface` or `text-body` do not exist and will not
resolve; a `:root` custom property alone does not generate one in Tailwind v4. Anyone building
an `@theme` mapping later must generate it from this file, not maintain a second copy of the
token list by hand. Light is defined on bare `:root`; dark is redefined under both
`@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])` **and**
`:root[data-theme="dark"]`, so the explicit toggle wins in both directions and the system
default works without one.

**No component may use a raw hex value.** A lint rule enforces it, scoped to `packages/ui` and
`apps/web`. A hardcoded colour is a colour that will be wrong in dark mode, and dark mode is
not optional for a tool people use at 2am during an incident.

**`--text-sm` collides with a Tailwind v4 built-in theme variable of the same name.**
Tailwind's own default theme defines `--text-sm: 0.875rem` plus `--text-sm--line-height`
inside `@layer theme`. Because this file's `:root` block is unlayered CSS following
`@import 'tailwindcss'`, it wins the cascade over anything inside `@layer theme` regardless of
source order — confirmed by compiling this file with `tailwindcss@4.3.3`'s own compiler.
The practical effect: Tailwind's built-in `text-sm` utility silently takes this design
system's `13px` for its font-size (since it reads `var(--text-sm)`), but keeps *Tailwind's*
line-height ratio, not this file's `--leading-sm: 20px` — the two were never paired, because
`--leading-sm` and `--text-sm--line-height` are different variable names. Do not use the bare
`text-sm` utility on this design system's typography. (There is no bare `leading-sm` utility to
avoid in the first place — Tailwind's `--leading-*` theme namespace only has
`tight`/`snug`/`normal`/`relaxed`/`loose`, no `sm`, so `leading-sm` generates no CSS at all.)
Every primitive in `packages/ui` instead pairs `text-[length:var(--text-sm)]` with
`leading-[var(--leading-sm)]` explicitly, and any new component should do the same. No other
token in this file collides with a Tailwind v4 theme variable — checked all 48 token names
here against tailwindcss@4.3.3's full theme namespace: `--color-*`, `--text-*`, `--leading-*`,
`--radius-*`, `--ease-*`, and `--duration-*` (Tailwind v4 has no `--duration-*` namespace at
all). `--row-height-*` isn't a Tailwind namespace either, so it can't collide.

## 8. Voice

Sentence case everywhere — never Title Case, never ALL CAPS outside the `text-micro` eyebrow.

Buttons name the outcome: "Start scan", "Generate report", "Revoke key" — never "Submit",
"OK", or "Confirm". The verb stays constant through the flow: the button that says "Start
scan" produces a toast that says "Scan started".

Errors state what happened and what to do, in the product's voice, without apologising:
"This target isn't covered by the project scope. Add an allow rule for `app.example.com` to
scan it." Not "Oops! Something went wrong."

Empty states name the thing, say why it is empty, and put the primary action inline: "No
findings yet. Findings appear here after your first scan completes. [Start a scan]"

We never call a user's vulnerabilities "issues" in one place and "findings" in another. The
vocabulary is fixed: **asset, scope, scan, finding, occurrence, evidence, retest, engagement,
report.** These are the nouns the product is built from and they never vary.
