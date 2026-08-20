# Tables and data views

> **Status: Designed. Not Implemented.** Phase 1 (`DataTable`), refined in Phase 5.

The findings table is the most-used screen in the product. Marcus opens it every morning and
works down it. Its quality determines whether the product is pleasant or exhausting.

## 1. Anatomy

```
+--------------------------------------------------------------------+
| Filters: [Status v][Severity v][Project v][Assignee v]  [Save view] |
| 3 active: Open x  Critical+High x  Acme Prod x         [Clear all]  |
+--------------------------------------------------------------------+
| [ ] | Sev | Finding                | Asset      | Age | Assignee |   |
+-----+-----+------------------------+------------+-----+----------+---+
|▐[ ] | ◆ C | SQL injection in /sea… | app.acme…  | 3d  | MA       | >|
|▐[ ] | ▲ H | Missing HSTS           | api.acme…  | 12d | —        | >|
+--------------------------------------------------------------------+
| 2 selected: [Assign] [Status v] [Export]     1–50 of 1,284  [More] |
+--------------------------------------------------------------------+
```

The leading `▐` is the severity spine ([`design-system.md`](design-system.md) §4).

## 2. Behaviour

**URL as state.** Filters, sort, density, and cursor live in the query string, so a view is
shareable, bookmarkable, and survives session expiry and reload. This single decision removes
an entire class of "I lost my place" complaints.

**Server-side everything.** Sorting, filtering, and pagination happen in Postgres against
indexed columns. Client-side sorting of a paginated set sorts the page rather than the data,
which is a lie the user will eventually notice.

**Cursor pagination by default**, on an indexed `(sortKey, id)` pair. Offset pagination only
where a jump-to-page control is genuinely needed, because offset degrades badly past a few
thousand rows and this product expects tenants with hundreds of thousands of findings.

**Virtualisation past 100 rows.** Row height is fixed per density mode so virtualisation is
simple and scrollbars are honest.

**Saved views.** A named filter combination, per user, optionally shared with the
organisation. "My criticals", "Unassigned highs in production", "Breaching SLA this week".
This is how a triage queue becomes a workflow rather than a search box.

## 3. Selection and bulk actions

Checkbox selection with shift-range. "Select all" selects the **loaded page** and offers
"select all 1,284 matching" as a distinct, explicit action — conflating the two is how people
accidentally bulk-close a thousand findings.

Bulk actions appear in a footer bar showing the exact count and requiring confirmation for
anything destructive or hard to reverse. Bulk operations run server-side in one transaction
where possible, and report per-item results rather than a single "done" when some items were
skipped for permission reasons.

## 4. Columns

Column visibility is user-configurable and persisted. Sensible defaults per view, not every
column at once. Priority columns never hide on narrow viewports; low-priority columns collapse
into an expandable row detail rather than causing horizontal scroll of the whole page.

Cells: text truncates with an ellipsis and a tooltip carrying the full value; numbers are
tabular and right-aligned; timestamps show relative with absolute on hover; identifiers and
fingerprints use the mono face with a copy affordance.

## 5. Required states

**Loading** — skeleton rows matching the final geometry, not a spinner, and not a layout
shift when data arrives. **Empty (no data)** — explains the entity and offers the primary
action. **Empty (no matches)** — distinct from no data: says which filters are active and
offers to clear them. Confusing these two is a common and genuinely frustrating bug.
**Error** — retains filters, offers retry, shows the request ID. **Partial** — shows loaded
rows and marks what failed.

## 6. Accessibility

Real `<table>` semantics with `<th scope>` and a `<caption>`. Sortable headers are buttons
with `aria-sort`. Row selection is announced. Keyboard: arrow keys move between rows, Enter
opens, Space selects, Shift+Space range-selects. The row count and active filters are
announced on change through a polite live region.

## 7. Export

Every table exports to CSV and JSON, honouring current filters, generated **server-side in a
worker** for anything beyond a few hundred rows and delivered as a download link.
Exports go through the same DTO layer as the API, so an export cannot leak fields the API
would not return, and every export writes an audit event.
