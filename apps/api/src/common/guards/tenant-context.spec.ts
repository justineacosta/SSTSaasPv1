import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type Permission,
  type SystemRole,
} from '@sentinel/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthenticatedOnly, Public, RequirePermission } from '../decorators/access.decorator.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { TENANT_RESOLVER } from '../../modules/roles/roles.tokens.js';
import {
  knownPermissions,
  resolveTenant,
  TenantContextGuard,
  type TenantResolutionInput,
  type TenantResolver,
} from './tenant-context.js';

/**
 * The refusal, parsed through the published envelope rather than read off an
 * `any`. `errorEnvelopeSchema` is the contract `AllExceptionsFilter` produces,
 * so a body that does not match it fails here rather than surviving as
 * `undefined === undefined`.
 */
const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

const ORG = 'org_01J000000000000000000001';

function input(overrides: Partial<TenantResolutionInput> = {}): TenantResolutionInput {
  return {
    activeOrganizationId: ORG,
    membership: {
      id: 'mbr_01J000000000000000000001',
      isActive: true,
      roleKey: 'ADMIN' satisfies SystemRole,
      permissions: ['organization.read'] satisfies Permission[],
    },
    organizationIsActive: true,
    ...overrides,
  };
}

describe('resolveTenant — layers 2 and 3 of security/authorization.md §2', () => {
  it('resolves an active membership in an active organisation', () => {
    const result = resolveTenant(input());
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.context.organizationId).toBe(ORG);
    expect(result.context.roleKey).toBe('ADMIN');
    expect(result.context.permissions.has('organization.read')).toBe(true);
  });

  it('reports no-active-organization when the session names none', () => {
    expect(resolveTenant(input({ activeOrganizationId: null })).outcome).toBe(
      'no-active-organization',
    );
  });

  it('reports not-a-member when there is no membership row', () => {
    expect(resolveTenant(input({ membership: null })).outcome).toBe('not-a-member');
  });

  /**
   * Carry-forward ruling 7 and `schema.prisma`: an `INVITED` row exists and is
   * not a membership. §2's layer 2 asks two questions — belongs, *and* active.
   */
  it('reports not-a-member for a membership that exists and is not active', () => {
    const membership = { ...input().membership!, isActive: false };
    expect(resolveTenant(input({ membership })).outcome).toBe('not-a-member');
  });

  /**
   * THE ORDER IS THE TEST. A non-member of a suspended organisation must hear
   * the membership answer, not the organisation's — the suspension is a fact
   * about somebody else's tenancy. Reversing the two branches in the
   * implementation turns this red.
   */
  it('answers not-a-member, not organization-suspended, when both are true', () => {
    expect(resolveTenant(input({ membership: null, organizationIsActive: false })).outcome).toBe(
      'not-a-member',
    );
  });

  it('reports organization-suspended for an active member of an inactive organisation', () => {
    expect(resolveTenant(input({ organizationIsActive: false })).outcome).toBe(
      'organization-suspended',
    );
  });

  /**
   * `TenantContext.permissions` is a `ReadonlySet` so a handler cannot widen
   * its own authority mid-request. `ReadonlySet` is a compile-time guarantee
   * only, so this asserts the runtime value really is a `Set` — a `has()` that
   * silently came from an array would be O(n) and, worse, would have `add`.
   */
  it('hands back a Set, so has() is the lookup and there is no add() on the type', () => {
    const result = resolveTenant(input());
    if (result.outcome !== 'resolved') throw new Error('unreachable');
    expect(result.context.permissions).toBeInstanceOf(Set);
    expect(result.context.permissions.has('billing.manage')).toBe(false);
  });
});

describe('knownPermissions', () => {
  it('keeps a key the product recognises', () => {
    expect(knownPermissions(['organization.read', 'scan.create'])).toEqual([
      'organization.read',
      'scan.create',
    ]);
  });

  /**
   * Dropping is the safe direction: `@RequirePermission()` is typed against
   * `PERMISSIONS`, so a key outside that list can never be required and can
   * therefore never grant anything. What must NOT happen is the unknown string
   * arriving in a value typed as the union.
   */
  it('drops a key the product does not recognise', () => {
    expect(knownPermissions(['organization.read', 'finding.launch_missiles'])).toEqual([
      'organization.read',
    ]);
  });
});

/**
 * The guard, over real routing, a real exception filter and real error
 * envelopes. `buildGuardedApp` is the harness Task 7 built for exactly this.
 *
 * The principal is injected by a stub guard registered ahead of the one under
 * test, because `AuthenticationGuard` is not what is being proved here and
 * standing up a real session would make every case in this file need Postgres.
 */
@Controller('probe')
class ProbeController {
  @Public()
  @Get('public')
  publicRoute(): { ok: true; tenant: boolean } {
    return { ok: true, tenant: false };
  }

  @AuthenticatedOnly()
  @Get('authenticated')
  authenticatedRoute(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('organization.read')
  @Get('guarded')
  guardedRoute(): { ok: true } {
    return { ok: true };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Stands in for `AuthenticationGuard`, which is not what this file proves.
 *
 * Registered through `APP_GUARD`, like the guard under test, and **that is
 * load-bearing**: guards handed to `useGlobalGuards` after `app.init()` are
 * never applied, and the first version of this file did exactly that. Every
 * assertion in it passed while nothing ran — including one asserting that two
 * refusals were byte-identical, which they were, at 200. Carry-forward rulings
 * 58 and 66's family, found here by the three tests that expected a denial.
 */
const PRINCIPAL_STUB = 'TENANT_SPEC_PRINCIPAL';

interface PrincipalStub {
  readonly activeOrganizationId: string | null;
}

class FakePrincipalGuard {
  constructor(private readonly stub: PrincipalStub) {}
  canActivate(context: { switchToHttp: () => { getRequest: () => unknown } }): boolean {
    const req = context.switchToHttp().getRequest() as {
      principal?: { kind: 'user'; userId: string; sessionId: string };
      activeOrganizationId?: string | null;
    };
    req.principal = { kind: 'user', userId: 'usr_1', sessionId: 'ses_1' };
    req.activeOrganizationId = this.stub.activeOrganizationId;
    return true;
  }
}

async function bootWith(options: {
  activeOrganizationId: string | null;
  resolution?: Awaited<ReturnType<TenantResolver>>;
  onResolve?: () => void;
}): Promise<NestExpressApplication> {
  const resolver: TenantResolver = () => {
    options.onResolve?.();
    return Promise.resolve(
      options.resolution ?? {
        membership: {
          id: 'mbr_01J000000000000000000001',
          isActive: true,
          roleKey: 'ADMIN',
          permissions: ['organization.read'],
        },
        organizationIsActive: true,
      },
    );
  };

  const built = await buildGuardedApp({
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: TENANT_RESOLVER, useValue: resolver },
      {
        provide: PRINCIPAL_STUB,
        useValue: { activeOrganizationId: options.activeOrganizationId } satisfies PrincipalStub,
      },
      {
        provide: APP_GUARD,
        inject: [PRINCIPAL_STUB],
        useFactory: (stub: PrincipalStub) => new FakePrincipalGuard(stub),
      },
      { provide: APP_GUARD, useClass: TenantContextGuard },
    ],
  });
  app = built;
  return built;
}

describe('TenantContextGuard', () => {
  it('resolves nothing on a public route and never calls the resolver', async () => {
    let called = false;
    const built = await bootWith({
      activeOrganizationId: ORG,
      onResolve: () => {
        called = true;
      },
    });
    const response = await request(built.getHttpServer()).get('/api/v1/probe/public');
    expect(response.status).toBe(200);
    expect(called).toBe(false);
  });

  /**
   * The short circuit that makes this guard free in Phase 2: nothing writes
   * `Session.activeOrganizationId` until Task 13, so there is no query to make.
   */
  it('performs no query when the session names no organisation', async () => {
    let called = false;
    const built = await bootWith({
      activeOrganizationId: null,
      onResolve: () => {
        called = true;
      },
    });
    await request(built.getHttpServer()).get('/api/v1/probe/authenticated').expect(200);
    expect(called).toBe(false);
  });

  /**
   * THE ASYMMETRY, AND IT IS THE POINT OF THE WHOLE FILE. A removed member must
   * still reach the routes that are about them and not about a tenant —
   * otherwise they hold a credential no endpoint will answer, including logout.
   */
  it('admits an @AuthenticatedOnly() route when the tenant does not resolve', async () => {
    const built = await bootWith({
      activeOrganizationId: ORG,
      resolution: { membership: null, organizationIsActive: true },
    });
    await request(built.getHttpServer()).get('/api/v1/probe/authenticated').expect(200);
  });

  it('admits an @AuthenticatedOnly() route when the organisation is suspended', async () => {
    const built = await bootWith({
      activeOrganizationId: ORG,
      resolution: {
        membership: {
          id: 'mbr_1',
          isActive: true,
          roleKey: 'OWNER',
          permissions: ['organization.read'],
        },
        organizationIsActive: false,
      },
    });
    await request(built.getHttpServer()).get('/api/v1/probe/authenticated').expect(200);
  });

  it('admits a @RequirePermission() route when everything resolves', async () => {
    const built = await bootWith({ activeOrganizationId: ORG });
    await request(built.getHttpServer()).get('/api/v1/probe/guarded').expect(200);
  });

  it('refuses a @RequirePermission() route with 404 when there is no membership', async () => {
    const built = await bootWith({
      activeOrganizationId: ORG,
      resolution: { membership: null, organizationIsActive: true },
    });
    const response = await request(built.getHttpServer()).get('/api/v1/probe/guarded');
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses a @RequirePermission() route with 404 when no organisation is active', async () => {
    const built = await bootWith({ activeOrganizationId: null });
    const response = await request(built.getHttpServer()).get('/api/v1/probe/guarded');
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  /**
   * §6's rule, asserted as an identity rather than as two separate expectations:
   * "Cross-tenant access returns 404, identical to a genuinely absent resource."
   * Same status, same body, same headers — the Task 12 plan names all three.
   */
  it('answers not-a-member and no-organisation with byte-identical responses', async () => {
    const noMembership = await bootWith({
      activeOrganizationId: ORG,
      resolution: { membership: null, organizationIsActive: true },
    });
    const first = await request(noMembership.getHttpServer()).get('/api/v1/probe/guarded');
    await noMembership.close();

    const noOrganisation = await bootWith({ activeOrganizationId: null });
    const second = await request(noOrganisation.getHttpServer()).get('/api/v1/probe/guarded');

    // `requestId` is per-request and `timestamp` moves; everything else must
    // match exactly. Carry-forward ruling 77's substitution, on a new endpoint.
    const normalise = (body: unknown): string => {
      const envelope = envelopeOf(body);
      return JSON.stringify({
        ...envelope,
        error: { ...envelope.error, requestId: 'X', timestamp: 'X' },
      });
    };

    // The status is asserted OUTRIGHT, not only for equality. Two 200s are
    // byte-identical too, and that is exactly what this test reported while the
    // guard was not running.
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(normalise(first.body)).toBe(normalise(second.body));
    expect(Object.keys(first.headers).sort()).toEqual(Object.keys(second.headers).sort());
    expect(first.headers['content-type']).toBe(second.headers['content-type']);
  });

  it('refuses a @RequirePermission() route with 403 when the organisation is suspended', async () => {
    const built = await bootWith({
      activeOrganizationId: ORG,
      resolution: {
        membership: {
          id: 'mbr_1',
          isActive: true,
          roleKey: 'OWNER',
          permissions: ['organization.read'],
        },
        organizationIsActive: false,
      },
    });
    const response = await request(built.getHttpServer()).get('/api/v1/probe/guarded');
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('ORGANIZATION_SUSPENDED');
  });
});
