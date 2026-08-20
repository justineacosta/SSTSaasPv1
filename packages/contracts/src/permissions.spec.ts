import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PROJECT_SCOPED_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
  type SystemRole,
} from './permissions.js';

const docPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.claude/product/permissions.md',
);

interface DocRow {
  permission: string;
  cells: Record<string, string>;
}

/** Parses the single permission matrix table out of permissions.md. */
function parseMatrix(markdown: string): { roles: string[]; rows: DocRow[] } {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex(
    (line) => line.startsWith('| Permission |') && line.includes('OWNER'),
  );
  if (headerIndex === -1) throw new Error('Permission matrix header not found in permissions.md');

  const cellsOf = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

  const roles = cellsOf(lines[headerIndex] ?? '').slice(1);
  const rows: DocRow[] = [];

  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) break;
    const cells = cellsOf(line);
    const permission = (cells[0] ?? '').replaceAll('`', '').trim();
    if (permission === '') continue;
    rows.push({
      permission,
      cells: Object.fromEntries(
        roles.map((role, index) => [role, (cells[index + 1] ?? '').replaceAll('*', '').trim()]),
      ),
    });
  }
  return { roles, rows };
}

const { roles: docRoles, rows: docRows } = parseMatrix(readFileSync(docPath, 'utf8'));

describe('permissions.ts agrees with product/permissions.md', () => {
  it('declares the same seven system roles, in the same order', () => {
    expect([...SYSTEM_ROLES]).toEqual(docRoles);
  });

  it('declares exactly the permissions the document lists', () => {
    expect([...PERMISSIONS].sort()).toEqual(docRows.map((row) => row.permission).sort());
  });

  it('grants exactly what each row of the document grants', () => {
    for (const row of docRows) {
      for (const role of docRoles) {
        const cell = row.cells[role];
        const granted = ROLE_PERMISSIONS[role as SystemRole].includes(row.permission as Permission);
        // 'Y' granted, '-' not granted, 'P' granted but additionally gated on
        // an explicit project grant — which is still a grant in the matrix.
        expect(granted, `${role} / ${row.permission} (doc cell "${cell ?? ''}")`).toBe(
          cell === 'Y' || cell === 'P',
        );
      }
    }
  });

  it('marks every P cell as project-scoped', () => {
    const docProjectScoped = docRows
      .filter((row) => Object.values(row.cells).includes('P'))
      .map((row) => row.permission)
      .sort();
    expect([...PROJECT_SCOPED_PERMISSIONS].sort()).toEqual(docProjectScoped);
  });
});

describe('invariants from permissions.md', () => {
  it('gives OWNER every permission', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('withholds billing.manage from ADMIN — only OWNER changes what it costs', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('billing.manage');
  });

  it('gives AUDITOR audit.read but not evidence.read', () => {
    expect(ROLE_PERMISSIONS.AUDITOR).toContain('audit.read');
    expect(ROLE_PERMISSIONS.AUDITOR).not.toContain('evidence.read');
  });

  it('withholds finding.accept_risk and scan.create_aggressive from MEMBER', () => {
    expect(ROLE_PERMISSIONS.MEMBER).not.toContain('finding.accept_risk');
    expect(ROLE_PERMISSIONS.MEMBER).not.toContain('scan.create_aggressive');
  });
});
