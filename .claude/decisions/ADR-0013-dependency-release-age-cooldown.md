# ADR-0013 — A 24-hour release-age cooldown on every dependency, declared explicitly

**Status:** Accepted · **Date:** 2026-08-22

## Context

pnpm 11 refuses to install a package published within the last 24 hours. The threshold is a
default — `minimumReleaseAge`, expressed in minutes — and until this ADR **nothing in this
repository had chosen it**. It was inherited.

That inherited policy stopped this build four times.

Task 13 added Next.js. `pnpm install` resolved `next@16.3.2` and its nine `@next/swc-*` platform
binaries roughly three hours after they were published, and wrote a `minimumReleaseAgeExclude`
block into `pnpm-workspace.yaml` exempting all ten from the check. The exclusions were later
removed as unjustified. The lockfile entries stayed.

Every CI run on those commits then died in about 30 seconds:

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 10 lockfile entries failed verification:
  @next/env@16.3.2 was published at 2026-08-21T09:37:14.000Z, within the minimumReleaseAge cutoff (2026-08-21T07:58:24.064Z)
  …
  next@16.3.2 was published at 2026-08-21T09:38:38.000Z, within the minimumReleaseAge cutoff (2026-08-21T07:58:24.064Z)
```

Four runs, from two pushes — commits `21746c5` and `2dad5bb`, each firing a run on `main` and one
on `feat/phase-1-foundation` (runs `32546337142`, `32546354121`, `32561019222`, `32561020627`).
All four failed at the same step with the same error.

**The part this record exists for: the green run was caused by the passage of 24 hours, not by
any change.** Run `32565519240` (commit `486fc34`) began `pnpm install --frozen-lockfile` at
**2026-08-22T09:39:33Z**. The oldest-permitted cutoff at that instant was one day earlier —
2026-08-21T09:39:33Z — and `next@16.3.2`, published at 2026-08-21T09:38:38.000Z, had cleared it
by **55 seconds**. Nothing in the repository was edited between the last red run and the green
one that touched dependency resolution. A reader who sees only the green run will conclude the
problem was fixed. It was not; it aged out.

There is a second lesson underneath, and it generalises past this one policy. The comment in
`pnpm-workspace.yaml` claimed the exclusions were safe to remove because `pnpm install`,
`pnpm install --frozen-lockfile` and `pnpm install --lockfile-only` all succeeded locally. They
did, and the verification was worthless: with `node_modules` already in sync, pnpm prints
"Already up to date" and exits — measured 2026-08-22, `Done in 277ms` — **never running the
release-age check at all**. CI starts from an empty `node_modules` and performs the full pass. A
warm tree cannot observe this class of failure.

## Decision

**`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` explicitly.** A dependency must be at
least 24 hours old before this workspace will install it.

1440 minutes is the same number pnpm 11 defaults to, so **this changes no behaviour today**. That
is the point. The value is now a control this repository owns, with a written rationale and a
named cost, rather than a default that produced an unexplained 30-second install failure. It also
stops moving if pnpm changes its default.

`minimumReleaseAgeExclude` stays absent. The comment in `pnpm-workspace.yaml` records why, and
records that the removal's original justification was invalid.

Verified 2026-08-22 that pnpm reads and enforces the key from this file, rather than assuming the
name and placement were right:

- A throwaway workspace carrying only `minimumReleaseAge: 5256000` and a pinned `next@16.3.2`
  failed resolution with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, naming a cutoff computed from
  **that** value. The check fires off this file, at this key, at this nesting level.
- Setting a deliberately absurd value in a scratch copy of *this* workspace and reading it back
  with `pnpm config get minimumReleaseAge` returned the absurd value, not the default.

**Note what is deliberately not offered as proof.** `pnpm config get minimumReleaseAge` → `1440`
on the real workspace proves nothing on its own: 1440 is pnpm's default, so that command answers
`1440` whether or not the key is read. Only a non-default value distinguishes the two, which is
why both checks above use one. Recording a check that cannot fail as though it were evidence is
the exact mistake this ADR was written about — it would have been an embarrassing way to make it.

## Alternatives considered

**Keep inheriting the default (what was happening).** Rejected. It is invisible policy nobody
chose. The failure mode is a 30-second red build with an error message about "active policies"
that appear nowhere in the repository, and the natural reaction — add an exclude, or wait and
shrug — is exactly the wrong one. A supply-chain control that no document claims is a control
that no one defends.

**Disable the check (`minimumReleaseAge: 0`).** Rejected, and it is the tempting option because
it makes the red build go away immediately. It also removes the only thing standing between this
repository and a compromised release in the hours before anyone notices — which is precisely
when a compromised release does its damage. This is a security product; installing whatever was
published sixty seconds ago is not a posture it can hold.

**A longer window, e.g. 7 days.** Rejected for now, though it is defensible and may be right
later. A week of cooldown catches far more of the typical "malicious release yanked within
days" timeline. It costs a week of latency on genuine security patches to our own dependencies,
which is the wrong trade while the dependency tree is still being assembled and moves weekly.
Revisit once the tree is stable.

**Per-package excludes when something is urgently needed.** Rejected as the standing answer. An
exclude is a permanent hole punched for a transient problem — the entry outlives the urgency, and
the next reader has no way to tell an exemption that was reasoned from one that a tool wrote
automatically. Task 13's ten entries were written by `pnpm install` itself, not by a person.

**Vendor or pre-warm the pnpm store in CI so the check never runs.** Rejected. It makes the
symptom disappear by removing the verification, which is the same as disabling it while looking
more responsible.

## Consequences

**Positive.** The policy is legible: someone reading `pnpm-workspace.yaml` learns that a
24-hour cooldown applies, why, and what to do when it bites. It survives a change to pnpm's
defaults. The error a future engineer hits now has a document behind it.

**Negative — the real cost, stated plainly.**

- **Adding a dependency within 24 hours of its publication reds CI until it ages out.** This is
  not a hypothetical; it has already cost this build four failed runs and roughly half a day.
- **The correct response is to wait, or to pin the previous release. It is never to add an
  exclude.** If a release genuinely must be adopted inside the window, that is a decision with a
  name on it and a comment in `pnpm-workspace.yaml` explaining who accepted the risk and why —
  not a line a tool wrote.
- **A local `pnpm install` on a warm tree will not warn you.** It prints "Already up to date" and
  the check never runs. The first signal is a red CI run. Anyone adding a dependency should
  assume the cooldown applies and check the publication date before pushing.
- **Security patches to our own dependencies are delayed by up to 24 hours** by the same
  mechanism that protects us. That is the trade being made deliberately.

**Neutral.** The number can be raised without a migration; only the wait changes. Lowering it,
or disabling it, is a security decision and gets a superseding ADR rather than a quiet edit.
