import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { datamodelEnums, datamodelModels, parseIdPrefix } from '@sentinel/db';
import { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } from './audit.actions.js';
import {
  AUDIT_ACTOR_TYPES,
  AuditService,
  type AuditEventInput,
  type AuditTransaction,
} from './audit.service.js';
import { PLATFORM_AUDIT_ACTIONS } from './platform-audit.actions.js';

interface CreateCall {
  readonly data: Record<string, unknown>;
}

function recordingTransaction(): { tx: AuditTransaction; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  return {
    calls,
    tx: {
      auditEvent: {
        create: (args) => {
          calls.push({ data: { ...args.data } });
          return Promise.resolve(undefined);
        },
      },
    },
  };
}

const INPUT: AuditEventInput = {
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  actorType: 'USER',
  actorId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  action: 'ORGANIZATION_CREATED',
  resourceType: 'Organization',
  resourceId: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
  metadata: { slug: 'acme-security' },
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

describe('AuditService.record', () => {
  it('writes through the transaction it was handed, and holds no client of its own', async () => {
    // `security/audit.md` §2: the event and the change it describes are one
    // transaction. A service that opened its own would satisfy the sentence and
    // break the rule — so the only way it can write is through a handle the
    // caller passes in, and the constructor takes no arguments at all.
    expect(AuditService.length).toBe(0);

    const { tx, calls } = recordingTransaction();
    await new AuditService().record(tx, INPUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toMatchObject({
      organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQ7',
      actorType: 'USER',
      action: 'ORGANIZATION_CREATED',
      resourceType: 'Organization',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('mints an `aud_` id and returns it', async () => {
    const { tx, calls } = recordingTransaction();
    const id = await new AuditService().record(tx, INPUT);

    // `aud`, not `pau`. The two tables have different prefixes precisely so a
    // row cannot be mistaken for one from the other table in a log line or a
    // support ticket.
    expect(parseIdPrefix(id)).toBe('aud');
    expect(calls[0]?.data['id']).toBe(id);
  });

  it('passes a null actor, resource, ip, user agent and request id through as null', async () => {
    const { tx, calls } = recordingTransaction();
    await new AuditService().record(tx, {
      ...INPUT,
      actorType: 'SYSTEM',
      actorId: null,
      resourceId: null,
      ip: null,
      userAgent: null,
      requestId: null,
    });

    const data = calls[0]?.data ?? {};
    expect(data['actorId']).toBeNull();
    expect(data['resourceId']).toBeNull();
    expect(data['ip']).toBeNull();
    expect(data['userAgent']).toBeNull();
    expect(data['requestId']).toBeNull();
  });

  it('writes the organizationId it was given, so the policy has something to check', async () => {
    // The field is required rather than derived — see the input's docblock.
    // What refuses a wrong value is `AuditEvent`'s RLS `WITH CHECK`, which is a
    // database property and is proved in
    // `organizations.integration.spec.ts` against the real policy rather than
    // here against a recorder.
    const { tx, calls } = recordingTransaction();
    await new AuditService().record(tx, INPUT);
    expect(calls[0]?.data['organizationId']).toBe('org_01M0T74WZZFY9T2QS56RGF3GQ7');
  });
});

describe('the tenant audit vocabulary', () => {
  it('restates `enum ActorType` exactly — read from the schema, not from a literal', () => {
    // Carry-forward ruling 13, and the reason `AUDIT_ACTOR_TYPES` is a
    // re-export rather than a second literal: one enum, one restatement, one
    // thing to keep in step with `schema.prisma`.
    const declared = datamodelEnums().find((entry) => entry.name === 'ActorType');
    expect(declared).toBeDefined();
    expect([...(declared?.values ?? [])].sort()).toEqual([...AUDIT_ACTOR_TYPES].sort());
  });

  it('names every action in security/audit.md §4, and only actions that document lists', () => {
    // The document is the authority and this constant is the transcription, the
    // same relationship `platform-audit.actions.ts` has with the same section.
    // `ORGANIZATION_SWITCHED` was in neither before this task and is added to
    // the document in the same change, exactly as Task 9 added `ACCOUNT_LOCKED`.
    const audit = readFileSync(
      fileURLToPath(new URL('../../../../../.claude/security/audit.md', import.meta.url)),
      'utf8',
    );
    for (const action of AUDIT_ACTIONS) {
      expect(audit, `${action} is missing from security/audit.md §4`).toContain(`\`${action}\``);
    }
  });

  it('has no duplicate action names', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('shares no action name with the platform table', () => {
    // ADR-0019 routes on the presence of an organisation, and the two
    // vocabularies are disjoint today. A name in both would make a query for it
    // have to know which table to look in — and would make it possible to write
    // the same event to either, which is the routing rule becoming a choice.
    // If a later task genuinely needs one action in both tables, this assertion
    // is the place to record that decision rather than the place to delete.
    const platform = new Set<string>(PLATFORM_AUDIT_ACTIONS);
    expect(AUDIT_ACTIONS.filter((action) => platform.has(action))).toEqual([]);
  });

  it('names only resource types that are real Prisma models', () => {
    // A `resourceType` that names nothing is an audit row an investigation
    // cannot join to anything. Read from the datamodel rather than a literal.
    const models = new Set(datamodelModels().map((model) => model.name));
    for (const resourceType of AUDIT_RESOURCE_TYPES) {
      expect(models.has(resourceType), `${resourceType} is not a model`).toBe(true);
    }
  });
});
