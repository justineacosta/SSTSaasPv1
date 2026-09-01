import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { datamodelEnums, datamodelModels, parseIdPrefix } from '@sentinel/db';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_RESOURCE_TYPES } from './platform-audit.actions.js';
import {
  PLATFORM_AUDIT_ACTOR_TYPES,
  type PlatformAuditEventInput,
  PlatformAuditService,
  type PlatformAuditTransaction,
} from './platform-audit.service.js';

interface CreateCall {
  readonly data: Record<string, unknown>;
}

function recordingTransaction(): { tx: PlatformAuditTransaction; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  return {
    calls,
    tx: {
      platformAuditEvent: {
        create: (args) => {
          calls.push({ data: { ...args.data } });
          return Promise.resolve(undefined);
        },
      },
    },
  };
}

const INPUT: PlatformAuditEventInput = {
  actorType: 'USER',
  actorId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  action: 'USER_REGISTERED',
  resourceType: 'User',
  resourceId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  metadata: { verificationTokenId: 'vtk_01M0T74WZZFY9T2QS56RGF3GQ7', hasName: true },
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

describe('PlatformAuditService.record', () => {
  it('writes through the transaction it was handed, and holds no client of its own', async () => {
    // `security/audit.md` §2: the event and the change it describes are one
    // transaction. A service that opened its own would satisfy the sentence and
    // break the rule — so the only way it can write is through a handle the
    // caller passes in, and the constructor takes no arguments at all.
    expect(PlatformAuditService.length).toBe(0);

    const { tx, calls } = recordingTransaction();
    await new PlatformAuditService().record(tx, INPUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toMatchObject({
      actorType: 'USER',
      action: 'USER_REGISTERED',
      resourceType: 'User',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('mints a `pau_` id and returns it', async () => {
    const { tx, calls } = recordingTransaction();
    const id = await new PlatformAuditService().record(tx, INPUT);

    expect(parseIdPrefix(id)).toBe('pau');
    expect(calls[0]?.data['id']).toBe(id);
  });

  it('passes a null actor, resource, ip, user agent and request id through as null', async () => {
    // Not dropped and not defaulted to a string. An audit row that says "not
    // recorded" and one that says nothing are different facts, and §3 needs the
    // difference to survive.
    const { tx, calls } = recordingTransaction();
    await new PlatformAuditService().record(tx, {
      ...INPUT,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'REGISTRATION_BLOCKED_EXISTING_EMAIL',
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
});

describe('the platform audit vocabulary', () => {
  it('restates `enum ActorType` exactly — read from the schema, not from a literal', () => {
    // Carry-forward ruling 13. Task 2's restatement specs compared a constant
    // to a hard-coded copy of itself in the same package and stayed green when
    // `schema.prisma` changed; this reads the generated DMMF instead.
    const declared = datamodelEnums().find((entry) => entry.name === 'ActorType');
    expect(declared).toBeDefined();
    expect([...(declared?.values ?? [])].sort()).toEqual([...PLATFORM_AUDIT_ACTOR_TYPES].sort());
  });

  it('names every action in security/audit.md §4, and only actions that document lists', () => {
    // The document is the authority and this constant is the transcription, the
    // same relationship `rate-limit.config.ts` has with abuse-prevention.md §1.
    // §4 had no name for registration at all before this task, and the two
    // halves of that change — the document and the code — are held together
    // here rather than by anyone remembering.
    const audit = readFileSync(
      fileURLToPath(new URL('../../../../../.claude/security/audit.md', import.meta.url)),
      'utf8',
    );
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      expect(audit, `${action} is missing from security/audit.md §4`).toContain(`\`${action}\``);
    }
  });

  it('has no duplicate action names', () => {
    expect(new Set(PLATFORM_AUDIT_ACTIONS).size).toBe(PLATFORM_AUDIT_ACTIONS.length);
  });

  it('carries the four names login and logout write', () => {
    // Task 9. `LOGIN`, `LOGIN_FAILED` and `LOGOUT` were already in §4's Auth
    // list and had no producer; `ACCOUNT_LOCKED` was in neither, and is added
    // to the document in the same change as the constant. Ruling 62 is why all
    // four are here rather than in an `AuditEvent`: a login happens with no
    // organisation in hand, and `AuditEvent`'s RLS policy refuses that insert.
    for (const action of ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'ACCOUNT_LOCKED']) {
      expect(PLATFORM_AUDIT_ACTIONS as readonly string[]).toContain(action);
    }
  });

  it('carries the four names password reset and change write', () => {
    // Task 10. Three of the four were already in §4's Auth list with no
    // producer, exactly as `LOGIN` and `LOGOUT` were before Task 9.
    // `PASSWORD_CHANGE_FAILED` was in neither, and is added to the document in
    // the same change as this constant.
    //
    // All four are `PlatformAuditEvent` rows for ruling 62's reason: a reset is
    // requested and completed by somebody who has chosen no organisation, and
    // `AuditEvent`'s RLS policy refuses an insert that carries none — measured
    // twice in Task 8, not inferred.
    for (const action of [
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
      'PASSWORD_CHANGED',
      'PASSWORD_CHANGE_FAILED',
    ]) {
      expect(PLATFORM_AUDIT_ACTIONS as readonly string[]).toContain(action);
    }
  });

  it('names `Session` as a resource type, because logout is about one', () => {
    // A logout's `resourceId` is the session that was revoked, not the user:
    // the user is still the user afterwards, and the thing that changed is the
    // session row. The assertion below it proves `Session` is a real model.
    expect(PLATFORM_AUDIT_RESOURCE_TYPES as readonly string[]).toContain('Session');
  });

  it('names only resource types that are real Prisma models', () => {
    // A `resourceType` that names nothing is an audit row an investigation
    // cannot join to anything. Read from the datamodel rather than a literal,
    // for the same reason as the enum above.
    const models = new Set(datamodelModels().map((model) => model.name));
    for (const resourceType of PLATFORM_AUDIT_RESOURCE_TYPES) {
      expect(models.has(resourceType), `${resourceType} is not a model`).toBe(true);
    }
  });
});
