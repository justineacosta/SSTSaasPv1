import type { Logger } from '@sentinel/observability';
import { ROLE_PERMISSIONS, type Permission, type SystemRole } from '@sentinel/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import type { TenantResolver } from '../../common/guards/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  OrganizationSwitchService,
  type SessionDocumentBuilder,
  type SessionRotator,
  type TenantTransactionBase,
} from './organization-switch.service.js';

/**
 * RULING 82 ON THE SWITCH PATH — THE POST-ROTATE MEMBERSHIP RE-READ.
 *
 * `POST /auth/switch-org` reads the membership, then calls `rotate`, which
 * **inserts a new `Session` row**. A concurrent member removal revokes sessions
 * with one `updateMany` whose predicate is evaluated at execution time, so it
 * cannot revoke a row that does not exist yet. Before this check the switch
 * answered 200 and left a live, `ACTIVE`, un-revoked session pointed at the
 * organisation the caller had just been removed from — measured against real
 * Postgres with a 2 s delay instrumented between the read and the rotation, and
 * `GET /auth/session` then served that organisation's `id`, `slug` and `name`
 * to a non-member.
 *
 * # Why this is a unit spec and what it therefore does not prove
 *
 * The window is real and it is microseconds wide; an integration test cannot
 * land inside it without instrumenting the service, and a test that instruments
 * the thing it is testing is not a regression test. What is deterministic is the
 * **decision**: given a first read that resolves and a second that does not, the
 * service must revoke the session it just issued and refuse. That is what these
 * arms hold, and each one asserts that `rotate` ran first — so a green tick here
 * cannot be produced by the first read refusing.
 *
 * The ordinary path — both reads resolve, a session is issued and the document
 * is returned — is held by `auth.switch-org.integration.spec.ts` against real
 * Postgres and Redis. It is not repeated here, because reaching it needs a real
 * Prisma client for the audit transaction.
 */

const USER = 'usr_01M0T74WZZFY9T2QS56RGF3GQ7';
const SESSION = 'ses_01M0T74WZZFY9T2QS56RGF3GQ7';
const SUCCESSOR = 'ses_01M0T74WZZFY9T2QS56RGF3GQ8';
const ORGANIZATION = 'org_01M0T74WZZFY9T2QS56RGF3GQ7';

type Read = { membership: 'active' | 'removed' | 'absent'; organizationIsActive: boolean };

const ACTIVE_MEMBER: Read = { membership: 'active', organizationIsActive: true };

function membershipRow(read: Read): {
  id: string;
  isActive: boolean;
  roleKey: SystemRole;
  permissions: readonly Permission[];
} | null {
  if (read.membership === 'absent') return null;
  return {
    id: 'mbr_01M0T74WZZFY9T2QS56RGF3GQ7',
    isActive: read.membership === 'active',
    roleKey: 'MEMBER',
    permissions: ROLE_PERMISSIONS.MEMBER,
  };
}

/**
 * The base Prisma client is never reached on any path these arms exercise — the
 * refusal is thrown before the audit transaction is opened — so this is a
 * placeholder whose only job is to satisfy the constructor.
 *
 * Written as an assertion through `unknown`, with the reasoning here rather than
 * as a bare `as`: a stub carrying `$transaction` and `$extends` would be a lie
 * about what this spec exercises, and handing the service a real client would
 * make it an integration test. If a future arm reaches it, the failure is a
 * `TypeError` naming the property, which is loud.
 */
const UNREACHED_BASE = null as unknown as TenantTransactionBase;

interface Harness {
  readonly service: OrganizationSwitchService;
  readonly reads: () => number;
  readonly rotated: () => number;
  readonly revoked: () => string[];
  readonly warnings: () => number;
}

/** A service whose resolver answers `reads[n]` on its n-th call. */
function harnessFor(reads: readonly Read[], options: { rotates?: boolean } = {}): Harness {
  let readCount = 0;
  let rotateCount = 0;
  const revoked: string[] = [];
  let warnCount = 0;

  const resolve: TenantResolver = (input) => {
    const read = reads[readCount] ?? reads.at(-1);
    readCount += 1;
    expect(input).toEqual({ userId: USER, organizationId: ORGANIZATION });
    if (read === undefined) throw new Error('no read configured');
    return Promise.resolve({
      membership: membershipRow(read),
      organizationIsActive: read.organizationIsActive,
    });
  };

  const sessions: SessionRotator = {
    rotate: () => {
      rotateCount += 1;
      return Promise.resolve(
        options.rotates === false
          ? null
          : { session: { id: SUCCESSOR }, token: 'tok', cookieMaxAgeSeconds: null },
      );
    },
    revoke: (sessionId: string) => {
      revoked.push(sessionId);
      return Promise.resolve(true);
    },
  };

  const sessionDocument: SessionDocumentBuilder = {
    forPrincipal: () => {
      throw new Error('the document must not be built on a refused switch');
    },
  };

  const audit: AuditService = {
    record: () => {
      throw new Error('a refused switch must not write an audit event');
    },
  };

  const logger = {
    warn: () => {
      warnCount += 1;
    },
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  return {
    service: new OrganizationSwitchService(
      resolve,
      sessions,
      sessionDocument,
      UNREACHED_BASE,
      audit,
      logger,
    ),
    reads: () => readCount,
    rotated: () => rotateCount,
    revoked: () => revoked,
    warnings: () => warnCount,
  };
}

const command = {
  userId: USER,
  sessionId: SESSION,
  organizationId: ORGANIZATION,
  ip: null,
  userAgent: null,
  requestId: 'req_01M0T74WZZFY9T2QS56RGF3GQ7',
};

const refusal = async (harness: Harness): Promise<DomainError> => {
  try {
    await harness.service.switch(command);
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('the switch was expected to be refused and was not');
};

describe('POST /auth/switch-org — the membership is re-read after the rotation', () => {
  it('revokes the session it has just issued when the membership went away in flight', async () => {
    const harness = harnessFor([
      ACTIVE_MEMBER,
      { membership: 'removed', organizationIsActive: true },
    ]);

    const error = await refusal(harness);

    expect(error.status).toBe(404);
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    // NOT VACUOUS (ruling 58): the first read resolved and the rotation ran, so
    // this refusal can only have come from the second read.
    expect(harness.rotated()).toBe(1);
    expect(harness.reads()).toBe(2);
    expect(harness.revoked()).toEqual([SUCCESSOR]);
    expect(harness.warnings()).toBe(1);
  });

  it('revokes it when the membership row is gone entirely, not merely inactive', async () => {
    const harness = harnessFor([
      ACTIVE_MEMBER,
      { membership: 'absent', organizationIsActive: true },
    ]);

    const error = await refusal(harness);

    expect(error.status).toBe(404);
    expect(harness.rotated()).toBe(1);
    expect(harness.revoked()).toEqual([SUCCESSOR]);
  });

  it('revokes it, and answers 403, when the organisation was suspended in flight', async () => {
    const harness = harnessFor([
      ACTIVE_MEMBER,
      { membership: 'active', organizationIsActive: false },
    ]);

    const error = await refusal(harness);

    // The same status and code the FIRST read gives for a suspension. A caller
    // who could tell the two apart would learn from the difference that their
    // membership was live when the request started.
    expect(error.status).toBe(403);
    expect(error.code).toBe('ORGANIZATION_SUSPENDED');
    expect(harness.rotated()).toBe(1);
    expect(harness.revoked()).toEqual([SUCCESSOR]);
  });

  it('produces a refusal indistinguishable from the one the first read produces', async () => {
    const first = await refusal(
      harnessFor([{ membership: 'removed', organizationIsActive: true }]),
    );
    const second = await refusal(
      harnessFor([ACTIVE_MEMBER, { membership: 'removed', organizationIsActive: true }]),
    );

    expect({ code: second.code, status: second.status, message: second.message }).toEqual({
      code: first.code,
      status: first.status,
      message: first.message,
    });
    // And the first one never rotated, so the two arms really are different
    // code paths reaching the same response.
    expect(second.message).toBe('Not found.');
  });

  it('does not re-read, and does not revoke, when there was nothing live to rotate', async () => {
    const harness = harnessFor([ACTIVE_MEMBER], { rotates: false });

    const error = await refusal(harness);

    expect(error.status).toBe(401);
    expect(error.code).toBe('SESSION_EXPIRED');
    expect(harness.reads()).toBe(1);
    expect(harness.revoked()).toEqual([]);
  });
});
