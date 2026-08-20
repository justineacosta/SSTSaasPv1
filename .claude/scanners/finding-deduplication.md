# Finding deduplication

> **Status: Designed. Not Implemented.** Phase 5.

If this is wrong, the product is unusable. A team scanning weekly with 200 findings and no
deduplication has 10,400 findings after a year, all of them the same 200. Every tool that
fails in this category fails here first.

## 1. Model

A **Finding** is a vulnerability. A **FindingOccurrence** is one sighting of it.

```
Finding  "Missing HSTS on app.example.com"   status=OPEN   firstSeen=Jan 3  lastSeen=Aug 20
  |- Occurrence  scan_001  Jan 3   evidence A
  |- Occurrence  scan_014  Feb 10  evidence B
  \- Occurrence  scan_072  Aug 20  evidence C
```

The user sees **one** row. History is available on demand. Triage state — assignment,
comments, accepted risk, remediation notes — attaches to the Finding and survives every
rescan, which is the entire point: a triage decision made in January must not be erased by a
scan in August.

## 2. Fingerprint

A deterministic SHA-256 over normalised, ordered inputs:

```
fingerprint = sha256(
  engineId + "|" + checkId + "|" +
  normalize(assetIdentity) + "|" +
  normalize(location) + "|" +
  normalize(discriminator)
)
```

Uniqueness: `UNIQUE (organizationId, assetId, fingerprint)`.

**Normalisation is where the work is.** Inputs are canonicalised before hashing:

| Input | Normalisation |
|---|---|
| Host | Lowercase, trailing dot stripped, IDN to punycode, default port removed |
| Path | Percent-decoded then re-encoded canonically, duplicate slashes collapsed, trailing slash normalised |
| Query | **Parameter *names* only, sorted.** Values excluded — `?id=1` and `?id=2` are the same vulnerability |
| Path IDs | Numeric and UUID segments replaced with `{id}` — `/users/42/edit` and `/users/99/edit` are one finding |
| Parameter | Name only, never the injected payload |
| Code location | File path + symbol, **never line number** (lines move; the vulnerability does not) |
| Dependency | Package + ecosystem + vulnerability ID, **not** installed version |

The path-ID rule is the highest-leverage one: without it, an IDOR check over a hundred user
IDs produces a hundred findings of the same defect.

## 3. What must and must not be in the fingerprint

**In:** the check, the asset, the stable location, and any genuine discriminator (which
header, which parameter, which cipher).

**Out — including these unconditionally:** timestamps, scan IDs, session tokens, nonces,
CSRF values, response bodies, payload values, line numbers, port numbers when default,
severity, and anything else that varies between runs without the underlying vulnerability
changing. A fingerprint containing a volatile value produces a new finding every scan, which
is the bug this whole design exists to prevent.

## 4. Ingestion algorithm

```
for each raw finding:
    fp = fingerprint(raw)
    existing = find(organizationId, assetId, fp)      # covered by the unique index

    if not existing:
        create Finding(status=OPEN, firstSeenAt=now, lastSeenAt=now)
        create Occurrence
        emit finding.created; notify per preferences

    else:
        create Occurrence                              # always append history
        existing.lastSeenAt = now
        existing.occurrenceCount += 1

        if existing.status in (REMEDIATED, RESOLVED):
            existing.status = REOPENED                 # it came back
            emit finding.reopened; notify              # this one always notifies
        elif existing.status in (FALSE_POSITIVE, ACCEPTED_RISK):
            pass                                       # respect the human decision, silently
        else:
            pass                                       # already open; no new notification

        if severity changed materially:
            record activity; notify if it increased
```

Three behaviours are deliberate and worth stating plainly:

- **Reopening always notifies.** A vulnerability returning after being fixed is the most
  important event the system can report.
- **`FALSE_POSITIVE` and `ACCEPTED_RISK` are never overridden by a scan.** A machine does
  not get to overrule a human's triage decision. The occurrence is still recorded, so the
  history is honest, but the status and the silence hold.
- **An existing `OPEN` finding generates no notification.** Re-notifying about known issues
  is how alerting gets muted.

## 5. Disappearance and auto-resolution

A finding *not* seen by a scan that *would have detected it* is a candidate for resolution.
The qualification matters: a scan that failed, timed out, or ran a different profile proves
nothing about the finding's absence.

Each scan therefore records which checks actually completed. A finding whose check completed
successfully and did not report it gets `missedScanCount += 1`. After a threshold (default
2 consecutive qualifying scans) the finding moves to `RESOLVED` with reason
`AUTO_NOT_DETECTED`, an activity entry, and a notification — never silently.

Manual findings are **never** auto-resolved; only a human or a retest closes them.

## 6. Cross-scan and cross-asset behaviour

The same fingerprint on a **different asset** is a different finding — `staging` and
`production` having the same misconfiguration are two problems with two owners and two
remediation timelines.

The same vulnerability found by **two different engines** produces two findings, because
`engineId` is in the fingerprint. These are surfaced as *related* rather than merged: a
`FindingRelation` table links them, the UI groups them, and a triage action can be applied
across the group. Automatic merging across engines was rejected because engines disagree
about what constitutes "the same" issue often enough that merging destroys information.

## 7. Manual findings

A tester's manual finding gets a fingerprint too, derived from the check taxonomy entry they
select plus the location they enter, so a manual finding and a later automated detection of
the same issue deduplicate correctly. Where a tester declines to classify, the fingerprint
falls back to a random value and the finding never auto-deduplicates — correct, since we
cannot infer identity we were not given.

## 8. Testing requirements

Same vulnerability across two scans produces one finding with two occurrences; different
path IDs on the same defect produce one finding; different query *values* produce one
finding; different parameter *names* produce two; normalisation handles case, trailing
slashes, default ports, encoding, and IDN; a fingerprint is stable across runs and across
engine patch versions; `FALSE_POSITIVE` survives a rescan; `REMEDIATED` reopens on
recurrence and notifies; auto-resolution triggers only after qualifying scans; a failed scan
never auto-resolves anything; two tenants with identical targets never collide.
