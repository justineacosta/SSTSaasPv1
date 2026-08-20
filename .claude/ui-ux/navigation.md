# Navigation model

> **Status: Designed. Not Implemented.** Phase 1 shell, populated per phase.

## 1. Shell

```
+----------------------------------------------------------------------+
| [Org switcher v]   [ Search / command  Ctrl+K ]   [bell] [avatar v]  |  56px
+--------------+-------------------------------------------------------+
|  Overview    |  Findings                              [density][new] |
|  Findings  12|  ---------------------------------------------------- |
|  Scans       |  breadcrumb > breadcrumb                              |
|  Assets      |                                                       |
|  Scope       |  content                                              |
|  Engagements |                                                       |
|  Reports     |                                                       |
|  --------    |                                                       |
|  Team        |                                                       |
|  Integrations|                                                       |
|  Billing     |                                                       |
|  Settings    |                                                       |
+--------------+-------------------------------------------------------+
   240px
```

Sidebar is collapsible to 56px icons, persisted per user. The badge on Findings shows open
criticals and highs only — a count that includes informational findings is a count nobody
reads.

## 2. Permission-aware navigation

Navigation is rendered **server-side** from the effective permission set, so a user never sees
a flash of a section they cannot enter. An item the user lacks permission for is omitted
entirely rather than shown disabled — a disabled nav item invites a support ticket about a
feature they do not have.

The exception is entitlement-gated features (SSO, custom roles): those *are* shown, with an
upgrade affordance, because that is a sales surface rather than a permission boundary. The
distinction is deliberate: hide what they may never have, show what they could buy.

## 3. Organisation switching

The switcher is the first element in the top bar, because a consultant working across six
client organisations must always know which one they are in — the cost of acting in the wrong
tenant is high and the mistake is easy.

Switching: clears the entire TanStack Query cache, resets to `/dashboard` rather than
attempting to map the current route across tenants, updates the URL organisation segment, and
re-fetches permissions. **Never** attempts to keep the user on the equivalent page in the new
organisation — the IDs do not transfer and a 404 after a switch is confusing in a way that
looks like a bug.

The active organisation's name is also rendered in the page title, so a background tab is
identifiable.

## 4. Command menu — `Ctrl/Cmd+K`

The primary navigation method for Priya and Marcus, who are keyboard-first. It searches
across projects, assets, findings, scans, engagements, and reports, and also exposes actions
("Start scan", "Create engagement", "Invite member") and settings destinations.

Results are permission-filtered server-side. Recent items first when the query is empty.
Debounced at 200ms. Arrow keys navigate, Enter opens, Cmd+Enter opens in a new tab.

## 5. Breadcrumbs

Every page below the top level shows its full ancestry, each level a link:

```
Projects > Acme Production > Assets > app.example.com > Verify ownership
```

Ancestry follows the domain hierarchy, not the URL path, so a finding reached from the global
queue still shows its project and asset — which is the context that makes the finding
interpretable.

## 6. Deep linking and state

Every filterable view keeps its state in the URL query string: filters, sort, density, and
cursor. This makes views shareable between teammates ("look at this filtered queue"),
bookmarkable, and restorable after a session expiry — the post-login redirect returns the user
to the exact view they were looking at, filters intact.

## 7. Mobile

Below `md`, the sidebar becomes a slide-over drawer behind a menu button; the top bar keeps
the organisation switcher and search. Mobile is a **review** experience, not a working one:
dashboards, finding detail, notifications, and approvals are fully usable; scan configuration,
scope editing, and report building are available but acknowledged as awkward and are not
optimised at the expense of the desktop density that the primary personas need.
