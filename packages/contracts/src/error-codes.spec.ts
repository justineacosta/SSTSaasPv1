import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_CODE_VALUES } from './error-codes.js';

/**
 * `ERROR_CODES` AND `api/errors.md` §3, HELD TOGETHER.
 *
 * Carry-forward ruling 27, open since Task 3: `PASSWORD_BREACHED` was added to
 * both lists by hand and nothing compared them. Same shape as ruling 5 (ID
 * prefixes) and ruling 13 (Prisma enums), and both of those turned out to have
 * already drifted by the time a spec was pointed at them.
 *
 * The document is the published contract — `api/errors.md` §1 says a client may
 * switch on `error.code` — so a code that exists in TypeScript and not in §3 is
 * an undocumented contract, and a code in §3 that no longer exists in
 * TypeScript is a documented promise nothing keeps. Direction is deliberately
 * both ways, unlike `enum-parity.spec.ts`'s db -> contracts, because neither
 * artefact here is downstream of the other.
 *
 * Modelled on `permissions.spec.ts`, which already reads `.claude/` from a
 * spec, so the path convention and the failure mode are not new.
 */
const docPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.claude/api/errors.md');

/**
 * The §3 slice only. §2's status table and §4's examples also mention codes in
 * backticks; including them would make this spec assert that every code
 * mentioned anywhere in the document is registered, which is a different and
 * much noisier claim.
 */
function codesSection(markdown: string): string {
  const start = markdown.indexOf('\n## 3. Codes');
  if (start === -1) throw new Error('errors.md has no "## 3. Codes" heading.');
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every backticked SCREAMING_SNAKE token in the section.
 *
 * Two characters minimum after the first, so a stray `§3` or a single letter
 * cannot register itself as a code. Section 3 contains no backticked
 * upper-case text that is not a code — verified by the count assertion below,
 * which is what makes this extraction safe to trust rather than merely
 * plausible.
 */
function documentedCodes(section: string): string[] {
  return [...section.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((match) => match[1] ?? '');
}

const section = codesSection(readFileSync(docPath, 'utf8'));
const documented = documentedCodes(section);

describe('ERROR_CODES agrees with api/errors.md §3', () => {
  it('extracted a plausible number of codes from the document', () => {
    // THE GUARD THAT KEEPS THE REST OF THIS SPEC HONEST. If the heading is
    // renamed or the markdown reshaped, `documented` silently becomes [] and
    // every set comparison below would compare two empty-ish lists and pass —
    // the exact "green under a real violation" failure the reviewer found
    // twice in Task 3. A hard floor turns a broken extraction into a red spec.
    expect(documented.length).toBeGreaterThanOrEqual(30);
    expect(section).toContain('**Validation:**');
  });

  it('documents every registered code', () => {
    const missing = Object.keys(ERROR_CODES).filter((code) => !documented.includes(code));
    expect(missing).toEqual([]);
  });

  it('registers every documented code', () => {
    const registered = new Set<string>(ERROR_CODE_VALUES);
    const undeclared = documented.filter((code) => !registered.has(code));
    expect(undeclared).toEqual([]);
  });

  it('lists each code exactly once in the document', () => {
    const duplicates = documented.filter((code, index) => documented.indexOf(code) !== index);
    expect(duplicates).toEqual([]);
  });
});

describe('ERROR_CODES itself', () => {
  it('maps every key to its own name, so a code cannot be mistyped into a valid one', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) expect(value).toBe(key);
  });

  it('exports the values as a non-empty tuple for z.enum', () => {
    expect(ERROR_CODE_VALUES.length).toBe(Object.keys(ERROR_CODES).length);
  });
});
