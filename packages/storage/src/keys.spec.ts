import { describe, expect, it } from 'vitest';
import { evidenceKeyForFinding, evidenceKeyForScan, reportKey, tenantPrefix } from './keys.js';

describe('storage keys', () => {
  it('always begins with the organisation prefix', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key.startsWith('org/org_01J/')).toBe(true);
  });

  it('places a finding artifact under its finding', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
    });
    expect(key).toMatch(/^org\/org_01J\/finding\/fnd_01J\/[0-9a-f-]{36}\.png$/);
  });

  it('places a scan artifact under its scan', () => {
    const key = evidenceKeyForScan({
      organizationId: 'org_01J',
      scanId: 'scn_01J',
      extension: 'json',
    });
    expect(key).toMatch(/^org\/org_01J\/scan\/scn_01J\/[0-9a-f-]{36}\.json$/);
  });

  it('builds report keys under the organisation', () => {
    expect(reportKey({ organizationId: 'org_01J', reportId: 'rpt_01J', extension: 'pdf' })).toMatch(
      /^org\/org_01J\/rpt_01J\/[0-9a-f-]{36}\.pdf$/,
    );
  });

  it('never reuses the original filename', () => {
    const key = evidenceKeyForFinding({
      organizationId: 'org_01J',
      findingId: 'fnd_01J',
      extension: 'png',
      originalFilename: '../../etc/passwd',
    });
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('..');
  });

  it('rejects an empty organisation id rather than building a prefix-less key', () => {
    expect(() => tenantPrefix('')).toThrow(/organisation/i);
  });

  it('rejects an extension containing a path separator', () => {
    expect(() =>
      evidenceKeyForFinding({ organizationId: 'org_01J', findingId: 'fnd_01J', extension: '../x' }),
    ).toThrow();
  });

  it('produces a distinct key each call, so keys are not enumerable', () => {
    const args = { organizationId: 'org_01J', findingId: 'fnd_01J', extension: 'png' } as const;
    expect(evidenceKeyForFinding(args)).not.toBe(evidenceKeyForFinding(args));
  });
});
