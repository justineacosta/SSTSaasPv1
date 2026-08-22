# ADR-0012 — Node 26 pinned for development and CI, engines >= 22

**Status:** Accepted · **Date:** 2026-08-22

## Context

The development host runs **Node v26.7.0** (verified 2026-08-22, `node --version`). The Phase 0
documents require Node ≥ 22 LTS.

Node 26 is not yet an LTS line. From the nodejs/Release schedule (read 2026-08-22):

| Line | Current | Enters LTS | Maintenance | End of life |
|---|---|---|---|---|
| v22 | maintenance since 2025-10-21 | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| v24 | **Active LTS** | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| v26 | Current | **2026-10-28** | 2027-10-20 | 2029-04-30 |

Node 26 reaches LTS in **October 2026** — before this product serves a single external request.
Choosing the runtime now therefore means choosing between the line the developer is actually
typing against and the line that is presently blessed.

There is a second force. This repository leans on Node's native TypeScript type-stripping: the
root `check:*` scripts run `node scripts/*.ts` directly, with no build step and no `tsx`. That
capability is newer than Node 22 and is not something to be casual about downgrading.

## Decision

- **`.nvmrc` pins `26`.** Verified: the file contains exactly `26`.
- **CI reads that file rather than repeating the number.** Verified:
  `.github/workflows/ci.yml` sets `node-version-file: .nvmrc` on `actions/setup-node`, so the
  pin has exactly one home and cannot drift between the terminal and the runner.
- **Root `engines.node` stays `">=22"`.** Verified: `package.json` declares
  `"engines": { "node": ">=22" }`. No workspace package declares its own `engines`.

The pin and the floor are deliberately different numbers. The pin says *what we develop and
verify on*; the floor says *what the packages claim to be consumable on*. Pinning 26 while
claiming ≥ 22 means we do not ship a package that gratuitously refuses the current LTS.

## Alternatives considered

**Pin CI to 24, the Active LTS.** Rejected, but it is the closest call here. Every dependency
officially supports 24 today, and it is what a conservative shop would do. It loses because
developing on 26 and verifying on 24 puts the *newer* runtime in the place where nothing checks
it: a Node 26-only failure would reach a developer's terminal and never reach CI, which is
backwards. The point of CI is to run what the developer runs.

**A 24 + 26 matrix.** Rejected for now. It catches breakage in both directions, which is the
honest technical argument for it — and it doubles CI minutes on a pipeline that already takes
4m22s end to end (run `32565519240`, as recorded in
[`../product/roadmap.md`](../product/roadmap.md)), and it wedges the whole build on the first dependency that is not yet Node
26-ready. Revisit if this product ever ships a package for external consumption, where the
consumer's runtime genuinely varies.

**Raise `engines.node` to `">=26"` to match the pin.** Rejected. It buys nothing — nothing
outside this repository installs these packages — and it would refuse to install on the current
LTS for a requirement we have not demonstrated.

**Drop the pin and use whatever is installed.** Rejected. That is how "works on my machine"
enters a repository.

## Consequences

**Positive.** One number, one file, read by both the terminal and the runner. Native TypeScript
execution is available everywhere, so the `check:*` scripts need no build step and no extra
dependency. The runtime the developer sees a failure on is the runtime CI sees it on.

**Negative — named plainly.**

- **Node 26 is not LTS today.** Until 2026-10-28 the pinned line receives Current-line churn,
  and a regression in a Current release lands on this build before it lands on anyone
  conservative.
- **The floor is untested.** `engines.node: ">=22"` is a claim nothing verifies — no CI job runs
  on Node 22 or 24. If someone actually needs Node 22 support, that is a matrix job to add, not
  a fact this ADR establishes.
- **`@types/node` is pinned at `^22.0.0`** while the runtime is 26. Typechecking therefore sees
  a Node 22 standard library. That is conservative rather than wrong — it cannot type-approve an
  API that Node 22 lacks — but it does mean a Node 26-only API is a type error before it is a
  runtime success.

**Revisit trigger — explicit.** Supersede this ADR with a new one if **any** of the following
becomes true:

1. A dependency this repository needs does not support Node 26, and there is no near-term fix.
2. Node 26's LTS date slips past **October 2026**.
3. This product begins publishing packages for consumption outside this repository, at which
   point the untested `>=22` floor has to become a tested matrix or an honest `>=26`.

In cases 1 and 2 the action is to drop `.nvmrc` (and therefore CI) to 24 and record that as the
superseding ADR.
