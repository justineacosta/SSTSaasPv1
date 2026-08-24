### Task 5: `packages/contracts` — errors, pagination, IDs, permission matrix

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/error-codes.ts`, `packages/contracts/src/error-envelope.ts`, `packages/contracts/src/pagination.ts`, `packages/contracts/src/ids.ts`, `packages/contracts/src/permissions.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/error-envelope.spec.ts`, `packages/contracts/src/permissions.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ERROR_CODES` — const object; `type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
  - `errorEnvelopeSchema`, `type ErrorEnvelope`
  - `fieldErrorSchema`, `type FieldError`
  - `paginationSchema`, `collectionEnvelopeSchema<T>(item: T)`
  - `PERMISSIONS` — readonly array of every permission string; `type Permission`
  - `SYSTEM_ROLES` — readonly array of the 7 role keys; `type SystemRole`
  - `ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]>`
  - `PROJECT_SCOPED_PERMISSIONS: readonly Permission[]` — the `P` cells for `GUEST`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/permissions.spec.ts` — this is the test [`product/permissions.md`](../../../.claude/product/permissions.md) explicitly demands ("this table and that file must agree, and a test asserts it"). It parses the markdown table so the two cannot drift:

```ts
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
```

`packages/contracts/src/error-envelope.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { errorEnvelopeSchema } from './error-envelope.js';
import { collectionEnvelopeSchema } from './pagination.js';
import { z } from 'zod';

describe('errorEnvelopeSchema', () => {
  it('accepts a minimal envelope', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Something failed.', requestId: 'req_1' },
    });
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
  });

  it('accepts a validation envelope with per-field errors', () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'The request contains invalid fields.',
        requestId: 'req_1',
        details: {
          fields: [{ path: 'targets[0]', code: 'invalid_host', message: 'Enter a valid hostname.' }],
        },
      },
    });
    expect(parsed.error.details).toBeDefined();
  });

  it('rejects an unknown error code, so codes cannot be invented ad hoc', () => {
    expect(() =>
      errorEnvelopeSchema.parse({
        error: { code: 'MADE_UP', message: 'x', requestId: 'req_1' },
      }),
    ).toThrow();
  });

  it('rejects an envelope without a requestId', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'x' } }),
    ).toThrow();
  });
});

describe('collectionEnvelopeSchema', () => {
  it('wraps items with pagination and meta', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      data: [{ id: 'fnd_1' }],
      pagination: { nextCursor: 'abc', hasMore: true },
      meta: { total: 1284 },
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.pagination.hasMore).toBe(true);
  });

  it('allows a null cursor on the last page', () => {
    const schema = collectionEnvelopeSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({ data: [], pagination: { nextCursor: null, hasMore: false } });
    expect(parsed.pagination.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
pnpm vitest run --project unit packages/contracts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the contracts**

`packages/contracts/src/error-codes.ts` — the complete union from [`api/errors.md`](../../../.claude/api/errors.md) §3:
```ts
export const ERROR_CODES = {
  // Auth
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',

  // Access
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',

  // Domain — security testing
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  ASSET_NOT_VERIFIED: 'ASSET_NOT_VERIFIED',
  ASSET_VERIFICATION_EXPIRED: 'ASSET_VERIFICATION_EXPIRED',
  TARGET_DENIED_BY_POLICY: 'TARGET_DENIED_BY_POLICY',
  PROFILE_NOT_PERMITTED: 'PROFILE_NOT_PERMITTED',
  ENGINE_NOT_AVAILABLE: 'ENGINE_NOT_AVAILABLE',
  SCAN_ALREADY_RUNNING: 'SCAN_ALREADY_RUNNING',
  SCAN_NOT_CANCELLABLE: 'SCAN_NOT_CANCELLABLE',

  // Entitlement
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  // Rate limit
  RATE_LIMITED: 'RATE_LIMITED',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];
```

`packages/contracts/src/error-envelope.ts`:
```ts
import { z } from 'zod';
import { ERROR_CODE_VALUES } from './error-codes.js';

/**
 * A per-field validation error. `path` uses dotted/bracketed notation matching
 * the request body (`targets[0]`, `scope.rules[2].value`) so a client can map
 * the error onto its input without guessing. See api/errors.md §2.
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODE_VALUES),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
    documentation: z.string().url().optional(),
  }),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
```

`packages/contracts/src/pagination.ts`:
```ts
import { z } from 'zod';

export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const collectionMetaSchema = z.object({ total: z.number().int().nonnegative() });

/** Every list endpoint returns this shape. See api/conventions.md §4. */
export function collectionEnvelopeSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return z.object({
    data: z.array(item),
    pagination: paginationSchema,
    meta: collectionMetaSchema.optional(),
  });
}

export type Pagination = z.infer<typeof paginationSchema>;
```

`packages/contracts/src/ids.ts`:
```ts
import { z } from 'zod';

/**
 * Client-facing ID validation. Clients must not parse IDs (api/conventions.md
 * §1); this schema exists so the API can reject a malformed one at the boundary
 * rather than passing it to the database.
 */
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function idSchema(prefix: string) {
  return z
    .string()
    .refine(
      (value) => value.startsWith(`${prefix}_`) && ID_BODY.test(value.slice(prefix.length + 1)),
      { message: `Expected an identifier beginning with "${prefix}_".` },
    );
}

export const organizationIdSchema = idSchema('org');
export const userIdSchema = idSchema('usr');
export const membershipIdSchema = idSchema('mbr');
export const invitationIdSchema = idSchema('inv');
```

`packages/contracts/src/permissions.ts` — the machine-readable source of truth `permissions.md` names. Transcribe **every** row of that table:
```ts
export const SYSTEM_ROLES = [
  'OWNER',
  'ADMIN',
  'SECURITY_LEAD',
  'MEMBER',
  'VIEWER',
  'AUDITOR',
  'GUEST',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const PERMISSIONS = [
  'organization.read',
  'organization.update',
  'organization.delete',
  'organization.manage_members',
  'organization.manage_roles',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'asset.read',
  'asset.create',
  'asset.update',
  'asset.delete',
  'asset.verify_ownership',
  'scope.read',
  'scope.update',
  'scan.read',
  'scan.create',
  'scan.cancel',
  'scan.create_aggressive',
  'finding.read',
  'finding.create',
  'finding.update',
  'finding.triage',
  'finding.accept_risk',
  'finding.delete',
  'evidence.read',
  'evidence.upload',
  'evidence.delete',
  'engagement.read',
  'engagement.create',
  'engagement.update',
  'engagement.delete',
  'report.read',
  'report.create',
  'report.download',
  'apikey.read',
  'apikey.create',
  'apikey.revoke',
  'webhook.read',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'integration.read',
  'integration.manage',
  'notification.manage',
  'audit.read',
  'billing.read',
  'billing.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions marked `P` in product/permissions.md: granted to GUEST only for
 * projects explicitly shared with them. The role grant is necessary but not
 * sufficient — the project grant is checked separately.
 */
export const PROJECT_SCOPED_PERMISSIONS = [
  'project.read',
  'asset.read',
  'scope.read',
  'scan.read',
  'finding.read',
  'evidence.read',
  'engagement.read',
  'report.read',
  'report.download',
] as const satisfies readonly Permission[];

/**
 * The canonical role -> permission mapping. product/permissions.md is the
 * human-readable rendering of this object, and permissions.spec.ts parses that
 * document and asserts the two agree cell by cell.
 */
export const ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  OWNER: [...PERMISSIONS],

  ADMIN: [
    'organization.read', 'organization.update', 'organization.manage_members',
    'organization.manage_roles',
    'project.read', 'project.create', 'project.update', 'project.delete',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'finding.accept_risk', 'finding.delete',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update', 'engagement.delete',
    'report.read', 'report.create', 'report.download',
    'apikey.read', 'apikey.create', 'apikey.revoke',
    'webhook.read', 'webhook.create', 'webhook.update', 'webhook.delete',
    'integration.read', 'integration.manage',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  SECURITY_LEAD: [
    'organization.read',
    'project.read', 'project.create', 'project.update',
    'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.verify_ownership',
    'scope.read', 'scope.update',
    'scan.read', 'scan.create', 'scan.cancel', 'scan.create_aggressive',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage', 'finding.accept_risk',
    'evidence.read', 'evidence.upload', 'evidence.delete',
    'engagement.read', 'engagement.create', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
  ],

  MEMBER: [
    'organization.read',
    'project.read', 'project.create',
    'asset.read', 'asset.create', 'asset.update',
    'scope.read',
    'scan.read', 'scan.create', 'scan.cancel',
    'finding.read', 'finding.create', 'finding.update', 'finding.triage',
    'evidence.read', 'evidence.upload',
    'engagement.read', 'engagement.update',
    'report.read', 'report.create', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  VIEWER: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'integration.read',
    'notification.manage',
  ],

  // An auditor proves that testing happened and that findings were remediated.
  // They deliberately lack evidence.read: evidence routinely contains customer
  // secrets and PII, and a compliance reviewer rarely needs the vulnerability
  // detail itself. See product/permissions.md, "deliberate oddities".
  AUDITOR: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'engagement.read',
    'report.read', 'report.download',
    'apikey.read',
    'webhook.read',
    'integration.read',
    'notification.manage',
    'audit.read',
    'billing.read',
  ],

  // Every GUEST grant below is additionally gated on an explicit project grant.
  // A guest with no grants sees nothing.
  GUEST: [
    'organization.read',
    'project.read',
    'asset.read',
    'scope.read',
    'scan.read',
    'finding.read',
    'evidence.read',
    'engagement.read',
    'report.read', 'report.download',
    'notification.manage',
  ],
};
```

`packages/contracts/src/index.ts`:
```ts
export { ERROR_CODES, ERROR_CODE_VALUES } from './error-codes.js';
export type { ErrorCode } from './error-codes.js';
export { errorEnvelopeSchema, fieldErrorSchema } from './error-envelope.js';
export type { ErrorEnvelope, FieldError } from './error-envelope.js';
export { collectionEnvelopeSchema, collectionMetaSchema, paginationSchema } from './pagination.js';
export type { Pagination } from './pagination.js';
export {
  idSchema,
  invitationIdSchema,
  membershipIdSchema,
  organizationIdSchema,
  userIdSchema,
} from './ids.js';
export {
  PERMISSIONS,
  PROJECT_SCOPED_PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from './permissions.js';
export type { Permission, SystemRole } from './permissions.js';
```

`packages/contracts/package.json` and `tsconfig.json` follow the same shape as `packages/config`, with `zod` as the only dependency.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm vitest run --project unit packages/contracts
```
Expected: PASS, 12 tests.

If the matrix test fails, **the document is authoritative** — fix `permissions.ts` to match `permissions.md`, not the reverse. Changing the matrix is a product decision, not a typo fix.

- [ ] **Step 5: Verify and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add -A
git commit -m "$(cat <<'EOF'
feat(contracts): error envelope, pagination, IDs, and the permission matrix

packages/contracts is the spine: shapes defined once as Zod schemas and
imported by web, api, and workers, so a change that breaks a consumer breaks
the typecheck.

permissions.ts is the machine-readable source of truth that
product/permissions.md names. Its test parses that markdown table and
asserts agreement cell by cell, in both directions, so the two cannot drift.
The document is authoritative when they disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

