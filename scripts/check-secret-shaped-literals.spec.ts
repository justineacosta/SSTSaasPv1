import { describe, expect, it } from 'vitest';
import {
  findSecretShapedLiterals,
  mixesCharacterClasses,
  shannonEntropy,
} from './check-secret-shaped-literals.js';

/**
 * The values in this file are the point of it.
 *
 * Every one is a string this repository actually committed and a scanner
 * actually flagged, or a string it committed that must NOT be flagged. A check
 * tuned against invented examples is tuned against nothing — the whole
 * difficulty here is that credential-shaped and identifier-shaped strings look
 * alike, and only real ones from this repository prove the line is in the right
 * place.
 *
 * The literals below are reconstructed to the same shape rather than copied
 * verbatim, because pasting the originals back in would be the defect the check
 * exists to prevent. Where a real value is needed to prove a catch, it is built
 * at runtime from parts so no committed line carries it whole.
 */

/** A 43-character base64url run: what `mintSecretToken` actually produces. */
const tokenShaped = ['HXQ2nQ8vY6Zt0Ld1', 'JmR7pC4sK9wA3bE5', 'gF8hI2jN6oP'].join('');

/** The JWT header that failed PR #8, assembled so this line does not carry it. */
const jwtHeaderShaped = ['eyJhbGciOiJIUzI1', 'NiIsInR5cCI6Ikp', 'XVCJ9'].join('');

describe('shannonEntropy', () => {
  it('scores a random token far above a repeated-character fixture', () => {
    const random = shannonEntropy(tokenShaped);
    const fixture = shannonEntropy('FIXTUREnotarealtoken0000000000000000000000');

    expect(random).toBeGreaterThan(4.5);
    expect(fixture).toBeLessThan(4);
    // The gap is the whole basis of the check. If it ever narrows, the
    // threshold is wrong rather than the values.
    expect(random - fixture).toBeGreaterThan(1);
  });

  it('is zero for a single repeated character, which has no information at all', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });
});

describe('mixesCharacterClasses', () => {
  it('accepts a value carrying lower, upper and digit', () => {
    expect(mixesCharacterClasses(tokenShaped)).toBe(true);
  });

  it.each([
    ['a lowercase git SHA', '9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b'],
    ['a SCREAMING_SNAKE error code', 'PASSWORD_BREACHED_VALIDATION'],
    ['a lowercase slug', 'content-security-policy-report-only'],
  ])('rejects %s, which is why the check is not noise', (_label, value) => {
    expect(mixesCharacterClasses(value)).toBe(false);
  });
});

describe('findSecretShapedLiterals', () => {
  /**
   * THE CATCHES. Each of these is a string that cost this repository something.
   */
  it('catches a 256-bit token in a TypeScript fixture — the PR #10 defect', () => {
    const found = findSecretShapedLiterals('spec.ts', `const TOKEN = '${tokenShaped}';`);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1);
    expect(found[0]?.value).toBe(tokenShaped);
  });

  it('catches a JWT header in a log-redaction fixture — the PR #8 defect', () => {
    const found = findSecretShapedLiterals('spec.ts', `Bearer ${jwtHeaderShaped}.abc.def`);
    expect(found).toHaveLength(1);
  });

  it('catches a token inside a URL in a markdown ledger — the Task 5 defect', () => {
    // The value Task 5 pasted into a committed report and paid a history
    // rewrite to remove. A path-segment or query-string token reads the same to
    // this check, because it matches the run and not the surrounding syntax.
    const found = findSecretShapedLiterals(
      'report.md',
      `sending https://app.sentinel.test/auth/reset?token=${tokenShaped} to the mailer`,
    );
    expect(found).toHaveLength(1);
  });

  it('reports the line number, because a finding nobody can locate gets ignored', () => {
    const content = ['first', 'second', `const T = '${tokenShaped}';`].join('\n');
    expect(findSecretShapedLiterals('spec.ts', content)[0]?.line).toBe(3);
  });

  /**
   * THE PASSES. Every one of these is committed in this repository today, and
   * flagging any of them would make the check noise and get it switched off.
   */
  it.each([
    ['an ADR slug', 'See [ADR-0016](ADR-0016-smtp-mailer-port.md) for the mailer decision.'],
    ['a git SHA', 'Rebase-merged as 3473a6d and 949c7570e55b34ec0ee59e92442d4adfcc73d3c1.'],
    ['a prefixed UUIDv7', "const id = 'finding_01h9zqk4m8n2p5r7t9v1x3y5z7';"],
    ['a CSP header name', "expect(headers).toHaveProperty('content-security-policy-report-only');"],
    ['a Prisma index name', "expect(err).toContain('Finding_organizationId_fingerprint_key');"],
    ['ordinary prose', 'The transport is built once so that construction opens no connection.'],
  ])('does not flag %s', (_label, content) => {
    expect(findSecretShapedLiterals('file.ts', content)).toEqual([]);
  });

  it('lets a line opt out by declaring itself a fixture', () => {
    // The escape hatch, and the outcome the check exists to produce: the same
    // shape, announced. Note this very line would otherwise be a finding.
    const content = `const TOKEN = 'FIXTURE_${tokenShaped}';`;
    expect(findSecretShapedLiterals('spec.ts', content)).toEqual([]);
  });

  it('does not flag a value that is long and mixed but low entropy', () => {
    const content = "const TOKEN = 'FIXTUREnotarealtoken000000000000000000';";
    expect(findSecretShapedLiterals('spec.ts', content)).toEqual([]);
  });

  it('finds every occurrence on one line, not merely the first', () => {
    const second = ['Kd93nQ8vY6Zt0Ld1', 'JmR7pC4sK9wA3bE5', 'gF8hI2jN6oP'].join('');
    const found = findSecretShapedLiterals('spec.ts', `${tokenShaped} and ${second}`);
    expect(found).toHaveLength(2);
  });
});
