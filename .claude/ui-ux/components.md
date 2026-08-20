# Component inventory

> **Status: Designed. Not Implemented.** Primitives in Phase 1; domain components alongside
> the features that need them.

Three tiers. The boundary between them is enforced: primitives know nothing about the domain,
patterns know nothing about specific entities, and domain components never fetch data.

## 1. Primitives — `components/ui/`

shadcn/ui based, restyled to the tokens in [`design-system.md`](design-system.md). No raw hex
values, no arbitrary spacing.

Button (primary, secondary, ghost, destructive; sm/md/lg; loading and disabled states) ·
IconButton · Input · Textarea (auto-resize) · Select · Combobox (async, searchable) ·
MultiSelect · Checkbox · RadioGroup · Switch · Slider · DatePicker · DateRangePicker ·
Label · FormField · FormError · Card · Separator · Tabs · Accordion · Collapsible ·
Dialog · AlertDialog · Drawer · Sheet · Popover · Tooltip · DropdownMenu · ContextMenu ·
CommandMenu · Toast · Alert · Badge · Avatar · Progress · Skeleton · Spinner ·
Breadcrumb · Pagination · ScrollArea · Table primitives · Code · Kbd.

## 2. Patterns — `components/patterns/`

Page-level compositions used across features. These are where consistency actually comes from
— a product with excellent primitives and no patterns still ends up with fifteen different
page headers.

| Pattern | Responsibility |
|---|---|
| `PageHeader` | Title, description, breadcrumb, actions, tabs |
| `DataTable` | Sorting, filtering, column visibility, density, selection, bulk actions, cursor pagination, virtualisation past 100 rows, URL state sync |
| `FilterBar` | Composable filters, saved views, clear-all, active filter chips |
| `EmptyState` | Icon, title, explanation, primary action inline |
| `ErrorState` | What failed, retry, request ID for support |
| `PermissionState` | Which permission is missing and who can grant it |
| `LoadingSkeleton` | Per-layout skeletons that match final geometry |
| `ConfirmDialog` | Destructive confirmation; typed name for irreversible actions |
| `FormLayout` | Consistent form geometry, sticky actions, unsaved-changes guard |
| `DetailLayout` | Main panel + metadata sidebar + activity timeline |
| `StatCard` | Metric, delta, sparkline, drill-through link |
| `Timeline` | Chronological activity with actor, action, timestamp |
| `FileDropzone` | Drag-drop, progress, validation errors, retry |
| `CopyField` | Copy-to-clipboard with confirmation — used constantly for tokens and IDs |
| `RelativeTime` | Relative display, absolute on hover, correct timezone |
| `UpgradePrompt` | Entitlement-gated feature with usage and upgrade path |

## 3. Domain components — `components/domain/`

Entity-aware, presentational only. **They receive data and callbacks; they never fetch.** This
is what lets the same `FindingRow` appear in the global queue, a project view, an engagement,
and a report preview, each of which loads data differently.

**Findings:** `SeverityIndicator` (the spine — colour + glyph + label, never colour alone) ·
`ConfidenceBadge` · `FindingRow` · `FindingCard` · `FindingStatusBadge` ·
`FindingStatusMenu` (valid transitions only, from the state machine) · `CvssVector`
(expandable breakdown) · `RiskScore` (score plus its contributing factors) ·
`OccurrenceTimeline` · `SlaIndicator`.

**Evidence:** `EvidenceViewer` (type-dispatching) · `HttpExchangeView` (request/response
pair, syntax-highlighted, **escaped text, never markup**, diff between occurrences) ·
`ScreenshotViewer` (sandboxed origin, zoom) · `EvidenceList` · `RedactionControls`.

**Scanning:** `ScanStatusBadge` · `ScanProgress` (SSE-driven; **never timer-driven**) ·
`ScanLogViewer` (virtualised, follow-tail) · `EngineSelector` · `ProfileSelector` (with plain
explanation of what each profile does) · `ScanConfigForm` (generated from the engine's
`configurationSchema`).

**Assets and scope:** `AssetTypeIcon` · `AssetRow` · `CriticalityBadge` ·
`EnvironmentBadge` · `VerificationStatus` · `VerificationInstructions` (per method, copyable
token, live re-check) · `ScopeRuleEditor` · `ScopeSimulator` (paste a target, see the
decision and the rule that made it).

**Org and access:** `OrgSwitcher` · `MemberRow` · `RoleBadge` · `RoleSelector` ·
`PermissionMatrix` · `InvitationForm` · `ApiKeyRow` (with the once-only reveal) ·
`AuditEventRow`.

**Charts** (Recharts, tokenised, accessible): `SeverityDistribution` ·
`FindingsOverTime` · `RiskTrend` · `RemediationVelocity` · `CoverageChart` · `Sparkline`.
Every chart has a table equivalent behind a toggle, because a chart alone is not accessible
and because people need the numbers to paste into a report.

## 4. Rules

1. **Every interactive component supports keyboard operation.** No exceptions.
2. **Every data-bound component handles loading, empty, and error.** A component that assumes
   data exists is incomplete.
3. **No raw hex, no arbitrary spacing.** Tokens only, enforced by lint.
4. **No `dangerouslySetInnerHTML`** outside the reviewed markdown renderer.
5. **Domain components do not fetch.** If a component needs data, its parent supplies it.
6. Every primitive and pattern has a Storybook entry covering its states, which doubles as the
   accessibility and visual regression target.
7. `alert()`, `confirm()`, and `prompt()` are banned. Product interactions use `ConfirmDialog`
   and `Toast`.
