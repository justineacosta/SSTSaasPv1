# Accessibility

> **Status: Standard defined. Not Implemented.** Enforced from Phase 1 in CI.

Target: **WCAG 2.2 Level AA.** This is a contractual requirement for enterprise and public
sector customers, and it is far cheaper to build in than to retrofit.

## 1. Colour and contrast

Body text ≥ 4.5:1, large text and UI components ≥ 3:1, focus indicators ≥ 3:1 against
adjacent colours. Every token pairing in [`design-system.md`](design-system.md) is verified in
both themes, and the check runs in CI against the token file rather than relying on review.

**Severity is never conveyed by colour alone.** Every severity indicator carries a distinct
glyph (◆ ▲ ● ○ —) and a text label. The same rule applies to scan status, retest results, and
chart series — every chart uses shape or pattern in addition to colour, and has a table
equivalent.

## 2. Keyboard

Everything operable by mouse is operable by keyboard. Logical tab order following visual
order. No keyboard traps. Visible focus on every interactive element — never `outline: none`
without a replacement of equal or greater clarity.

Skip link to main content. Dialogs and drawers trap focus while open, restore it to the
trigger on close, and close on Escape. Menus and comboboxes follow the WAI-ARIA authoring
practices for arrow-key navigation, typeahead, and Home/End.

Shortcuts: `Ctrl/Cmd+K` command menu, `/` search, `Escape` close, `?` shortcut help. All
documented, all overridable, none conflicting with assistive technology or browser defaults.

## 3. Screen readers

Semantic HTML first — `<button>` for actions, `<a>` for navigation, real headings in order,
real lists, real tables with `<th scope>`. ARIA only where semantics genuinely fall short, and
never to paper over a `<div>` that should have been a button.

Landmarks: `banner`, `navigation`, `main`, `complementary`, `contentinfo`. One `<h1>` per
page. Accessible names on every control, including icon-only buttons. Decorative icons
`aria-hidden`.

Live regions for asynchronous change: `aria-live="polite"` for scan progress and toasts,
`aria-live="assertive"` for errors, `aria-busy` during loading. Route changes announce the new
page title and move focus to the main heading — otherwise a screen reader user has no idea
navigation occurred in a client-side app.

## 4. Forms

Every input has a visible `<label>` — placeholders are not labels. Errors are associated by
`aria-describedby` and marked `aria-invalid`, announced on submission, and focus moves to the
first invalid field. Required fields are marked in text as well as visually. Error text names
the problem and the fix, never "invalid input". Grouped controls use `<fieldset>` and
`<legend>`.

## 5. Motion and preferences

`prefers-reduced-motion: reduce` removes all transitions and animation, including the
scan-progress pulse, which becomes a static determinate bar. `prefers-contrast: more`
increases border strength and text contrast. `prefers-color-scheme` is honoured, and an
explicit theme choice overrides it in both directions. No parallax, no auto-playing motion,
no content that flashes more than three times per second.

## 6. Zoom and reflow

Usable at 200% zoom without loss of function, and at 320px equivalent width without horizontal
scrolling — except for genuinely wide content (HTTP captures, wide tables), which scrolls
inside its own container while the page body does not. Text uses relative units so browser
font-size settings are honoured. No fixed-height containers that clip text when it wraps.

## 7. Verification

Automated: `eslint-plugin-jsx-a11y` in lint, `axe-core` in component tests and in Playwright
across every route, contrast checked against the token file. **CI fails on violations rather
than warning** — a warning nobody blocks on is a warning nobody reads.

Manual, per release: keyboard-only pass through the primary journeys; screen reader pass
(NVDA on Windows, VoiceOver on macOS) on registration, scan creation, finding triage, and
report generation; 200% zoom pass; forced-colours pass.

Automated tooling catches roughly a third of real issues. The manual passes are not optional
polish; they are where the actual defects are found.

## 8. Known tensions

Density and accessibility pull against each other, and the primary personas want density. The
resolution: **comfortable mode is fully AA-compliant with 44px targets and is the default for
new users**; compact and dense are opt-in, remain keyboard and screen-reader complete, and
relax only pointer target size — which WCAG 2.2's target-size criterion permits where an
equivalent accessible alternative exists. The alternative here is the density control itself,
which is discoverable and persistent.
