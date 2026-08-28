import { describe, expect, it } from 'vitest';
import { ID_SCHEMA_PREFIXES } from '@sentinel/contracts';
import { ID_PREFIXES } from './id.js';

/**
 * THE TWO PREFIX REGISTRIES, HELD TOGETHER.
 *
 * `ID_PREFIXES` here is the generator side — what `newId()` can mint and what
 * `parseIdPrefix()` recognises. `ID_SCHEMA_PREFIXES` in `@sentinel/contracts`
 * is the validator side — what the API will accept in a request. They were
 * written independently in Phase 1, nothing compared them, and by the end of
 * that phase they disagreed. Extending both by hand fixed that day's drift and
 * did nothing about the next one; this spec is the thing that does.
 *
 * The comparison runs db -> contracts, never the other way. `packages/db`
 * already depends on `@sentinel/contracts`; the reverse dependency would be a
 * cycle, which is why this spec lives here and not beside `ids.ts`.
 */

/**
 * Prefixes that exist here and deliberately have no client-facing ID schema.
 *
 * The value is the reason and the reason is load-bearing: an unexplained entry
 * is how a client-addressable entity gets parked on this list to make the spec
 * go green. Requiring plain equality instead would force meaningless schemas
 * for rows nobody addresses by ID; requiring only "db is a superset" would let
 * a new prefix be added with no thought about the client at all. The allowlist
 * forces the thought and records the answer.
 */
const DB_ONLY_PREFIXES: Record<string, string> = {
  crd: 'Credential — a row addressed only through its owning User, never by ID.',
  rol: 'Role — addressed by its SystemRoleKey (`OWNER`, …) in the API, not by row ID.',
  prm: 'Permission — addressed by its permission key (`finding.triage`), not by row ID.',
  aud: 'AuditEvent — the audit query API is Phase 3; no contract addresses one yet.',
  pau: 'PlatformAuditEvent (ADR-0019) — same as `aud`, and for the same reason: Phase 3 owns the query API and no contract addresses a row of either table yet. Listed here rather than given a contract schema so the two audit tables are treated alike; giving one a client-facing schema and not the other would be a difference nothing in the API can act on.',
  req: 'Request correlation ID. It appears in the error envelope as free text, not as a resource.',
  fnd: 'Finding — registered ahead of the model. Its contracts arrive with the model in a later phase.',
  scn: 'Scan — registered ahead of the model, same as `fnd`.',
};

const dbPrefixes = new Set<string>(Object.values(ID_PREFIXES));
const contractPrefixes = new Set<string>(Object.values(ID_SCHEMA_PREFIXES));

describe('ID prefix parity between @sentinel/db and @sentinel/contracts', () => {
  it('has a db prefix for every contract prefix', () => {
    // A contract prefix with no generator behind it validates IDs that nothing
    // can ever mint.
    const missing = [...contractPrefixes].filter((prefix) => !dbPrefixes.has(prefix));
    expect(missing).toEqual([]);
  });

  it('accounts for every db prefix — either a contract schema or an allowlisted reason', () => {
    // Adding a prefix to `ID_PREFIXES` without adding a schema *or* a reason
    // turns this red, which is the whole point: the decision gets made once,
    // out loud, instead of being deferred until something leaks.
    const unaccounted = [...dbPrefixes].filter(
      (prefix) => !contractPrefixes.has(prefix) && !(prefix in DB_ONLY_PREFIXES),
    );
    expect(unaccounted).toEqual([]);
  });

  it('carries no allowlist entry for a prefix that now has a contract schema', () => {
    // The allowlist must shrink when a schema arrives, or it becomes a list of
    // claims that used to be true.
    const stale = Object.keys(DB_ONLY_PREFIXES).filter(
      (prefix) => contractPrefixes.has(prefix) || !dbPrefixes.has(prefix),
    );
    expect(stale).toEqual([]);
  });

  it('gives every allowlist entry a non-empty reason', () => {
    for (const [prefix, reason] of Object.entries(DB_ONLY_PREFIXES)) {
      expect(reason.length, `${prefix} has no reason`).toBeGreaterThan(0);
    }
  });
});
