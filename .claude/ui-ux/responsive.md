# Responsive strategy

> **Status: Designed. Not Implemented.** Applied from Phase 1.

## 1. Position

This is a **desktop-first professional tool** used mobile-responsively. That is a deliberate
statement of priority, not an excuse: the primary personas triage hundreds of findings and
write engagement reports, and neither task is improved by optimising for a 375px viewport at
the cost of desktop density.

Mobile is a first-class **review and response** experience. It is not a first-class
**production** experience, and pretending otherwise would produce a worse product on both.

| Task | Mobile |
|---|---|
| Review dashboard and trends | Fully supported |
| Read a finding and its evidence | Fully supported |
| Triage: assign, comment, change status | Fully supported |
| Approve, respond to notifications | Fully supported |
| Start a scan from an existing configuration | Supported |
| Configure a new scan, edit scope, build a report | Available, acknowledged as awkward |
| Bulk triage, side-by-side evidence diff | Desktop only, stated plainly rather than degraded silently |

## 2. Breakpoints

Tailwind defaults, with the layout decisions that matter attached to each:

| Token | Width | Layout |
|---|---|---|
| base | 360–639 | Single column, drawer nav, cards instead of tables, bottom action bar |
| `sm` | 640 | Two-column forms where sensible |
| `md` | 768 | Persistent sidebar appears; tables replace cards |
| `lg` | 1024 | Detail views gain their metadata sidebar |
| `xl` | 1280 | Full table column set; charts side by side |
| `2xl` | 1536 | Max content width 1600px, centred |

360px is the floor, not 320px — but every view must still *reflow* at 320px equivalent
(200% zoom on a 640px viewport) without horizontal page scroll, per
[`accessibility.md`](accessibility.md) §6.

## 3. Tables to cards

Below `md`, `DataTable` renders each row as a card: severity spine on the left edge, primary
identifier as the heading, two or three key attributes below, and the row action as a tap
target. Sorting and filtering move into a bottom sheet. Selection and bulk actions are
available but the count-confirmation is more explicit, because a mistaken bulk action is
easier to trigger by thumb.

## 4. Content that must not be squeezed

Some content is genuinely wide and shrinking it destroys it. HTTP request/response captures,
wide tables, scan logs, and report previews scroll **inside their own container** with
`overflow-x: auto`, while the page body never scrolls horizontally. On mobile these get a
full-screen presentation option, because reading a captured HTTP response through a 340px
window is not reading.

## 5. Touch

Minimum 44×44px targets on touch pointers, enforced regardless of density mode — the density
control affects pointer-fine devices only. Adequate spacing between adjacent destructive and
non-destructive actions. Swipe gestures are additive shortcuts, never the only way to reach an
action. Hover-only affordances always have a tap or focus equivalent, since hover does not
exist on touch.

## 6. Implementation

Mobile-first CSS: base styles are the small-viewport case, breakpoints add. Container queries
for components that appear in both wide and narrow contexts — a `FindingRow` in the main table
and the same row in a narrow sidebar should respond to *its container*, not the viewport.

Fluid type and spacing via `clamp()` between breakpoints rather than stepped jumps. Images
through `next/image` with correct `sizes`. Charts re-render on container resize and drop to
their table equivalent below `sm`, where a chart with eight series is unreadable anyway.

## 7. Verification

Playwright runs the primary journeys at 360, 768, 1280, and 1920. Visual regression at each.
CI asserts no horizontal page overflow at any breakpoint on any route — a check worth
automating because horizontal overflow is almost always introduced accidentally by a single
unconstrained child.
