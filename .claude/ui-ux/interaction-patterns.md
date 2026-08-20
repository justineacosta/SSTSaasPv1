# Interaction patterns

> **Status: Designed. Not Implemented.** Applied from Phase 1.

Consistent answers to recurring interaction questions, so that every feature does not
re-decide them.

## 1. Feedback

| Action | Feedback |
|---|---|
| Instant, in-context (assign, tag, toggle) | Optimistic update, no toast; revert with an error toast on failure |
| Deliberate, in-context (save settings) | Inline confirmation next to the action, 3s |
| Navigational (create, delete) | Toast + navigation to the result |
| Background (scan started, report queued) | Toast with a link to watch it |
| Long-running | Progress driven by real events, plus a notification on completion |
| Failure | Error toast naming the cause and the fix, with the request ID, persisting until dismissed |

Toasts appear bottom-right, stack to three, auto-dismiss after 5s (errors do not auto-dismiss),
and are announced through a live region.

## 2. Destructive actions

Three tiers, matched to reversibility:

**Reversible** (archive a project, disable a webhook) — do it, toast with Undo for 10s.
**Hard to reverse** (delete an asset, revoke a key) — `ConfirmDialog` naming the exact object
and the consequence, with the destructive action as the non-default button.
**Irreversible with blast radius** (delete an organisation, delete a project with findings) —
`ConfirmDialog` requiring the user to **type the object's name**, listing what will be
destroyed with counts, and stating what cannot be recovered.

Never `window.confirm()`. Never a destructive action as the default focused button. Never a
destructive action reachable by Enter from a form.

## 3. Optimistic updates

Used only where the action is low-risk, fast, and trivially reversible: assignment, tagging,
read/unread, column and density preferences, saved view selection.

**Never** used for: status transitions, risk acceptance, scan creation, deletion, permission
changes, or billing. In those cases the user waits for the server, because showing someone
that a critical finding is closed before the server agrees is a lie with consequences.

Failures roll back and explain, never silently.

## 4. Realtime

Live views subscribe to SSE and reflect real backend events only. Connection state is visible
when degraded: a subtle indicator when reconnecting, an explicit banner when the stream is
down and the view has fallen back to polling.

**Stale data is never presented as live.** If the stream drops and polling fails, the view says
so and shows the last-updated time. In a security product, the difference between "this scan
is running" and "this scan was running when we last heard" matters.

## 5. Loading

Skeletons matching the final layout, never a bare spinner for content, never a layout shift on
arrival. Progressive: render the shell and known data immediately, stream in what is slower.
Inline spinners only for in-place actions on a button that is already visible.

Under 200ms: no indicator at all — a flash of skeleton is worse than a brief pause.
Over 3s: an explanation of what is taking time. Over 10s: move it to a background job with a
notification, rather than making someone watch.

## 6. Search and filter

`Ctrl/Cmd+K` opens the command menu from anywhere. `/` focuses in-page search. Search debounces
at 200ms and shows a loading state in the results area, never by blocking input.

Filters apply immediately, show as removable chips, and sync to the URL. Zero results
distinguishes "nothing matches these filters" (offering to clear them) from "nothing exists
yet" (offering to create something).

## 7. Errors

Field errors inline. Form errors above the actions. Page errors replace content with an
`ErrorState`. Global errors (session expired, network down, organisation suspended) use a
banner.

Every error surface carries the request ID with a copy affordance, because the first thing
support will ask for is the request ID, and making the user find it in a devtools console is
unkind.

Session expiry: capture the intended destination, redirect to login, and **return the user
exactly where they were** — including filters and scroll position — after re-authentication.

## 8. Permissions

An action the user cannot perform is hidden if they could never have it, and shown disabled
with an explanation if a colleague could grant it: "Only owners and admins can invite members.
Ask an admin in Acme Corp."

An entitlement-gated feature is shown with an `UpgradePrompt` describing what it does, the
current limit, and the upgrade path — this is a sales surface, not an error.

## 9. Keyboard

`Ctrl/Cmd+K` command menu · `/` search · `Escape` close/cancel · `?` shortcut help ·
`g` then `d`/`f`/`s`/`a` go to dashboard/findings/scans/assets · `j`/`k` move through list rows ·
`Enter` open · `x` select · `Ctrl/Cmd+Enter` submit from a textarea.

Shortcuts never fire while a text input has focus, except the documented submit combination.
All are listed in the `?` overlay and are user-overridable.
