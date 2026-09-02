import 'reflect-metadata';
import { Controller, Get, SetMetadata } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  errorEnvelopeSchema,
  ROLE_PERMISSIONS,
  type ErrorEnvelope,
  type Permission,
  type TenantContext,
} from '@sentinel/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_METADATA_KEY,
  AuthenticatedOnly,
  Public,
  RequirePermission,
} from '../decorators/access.decorator.js';
import { Ctx } from '../decorators/ctx.decorator.js';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { AuthorizationGuard } from './authorization.guard.js';
import { EntitlementGuard } from './entitlement.guard.js';

/**
 * The refusal, parsed through the published envelope rather than read off an
 * `any`. `errorEnvelopeSchema` is the contract `AllExceptionsFilter` produces,
 * so a body that does not match it fails here rather than surviving as
 * `undefined === undefined`.
 */
const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

const TENANT_STUB = 'AUTHZ_SPEC_TENANT';

function contextWith(role: keyof typeof ROLE_PERMISSIONS): TenantContext {
  return {
    organizationId: 'org_01J000000000000000000001',
    membershipId: 'mbr_01J000000000000000000001',
    roleKey: role,
    permissions: new Set<Permission>(ROLE_PERMISSIONS[role]),
  };
}

/**
 * Stands in for `TenantContextGuard`. Registered through `APP_GUARD` because a
 * guard handed to `useGlobalGuards` after `app.init()` never runs — the mistake
 * `tenant-context.spec.ts`'s docblock records finding by watching three
 * denial tests fail.
 */
class FakeTenantGuard {
  constructor(private readonly tenant: TenantContext | null) {}
  canActivate(context: { switchToHttp: () => { getRequest: () => unknown } }): boolean {
    const req = context.switchToHttp().getRequest() as {
      principal?: unknown;
      tenant?: TenantContext;
    };
    req.principal = { kind: 'user', userId: 'usr_1', sessionId: 'ses_1' };
    if (this.tenant !== null) req.tenant = this.tenant;
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('authenticated')
  authenticatedRoute(): { ok: true } {
    return { ok: true };
  }

  /** MEMBER holds this one. */
  @RequirePermission('scan.create')
  @Get('scan-create')
  scanCreate(@Ctx() ctx: TenantContext): { role: string } {
    return { role: ctx.roleKey };
  }

  /** MEMBER does not: `product/permissions.md` gives it to SECURITY_LEAD and above. */
  @RequirePermission('finding.accept_risk')
  @Get('accept-risk')
  acceptRisk(): { ok: true } {
    return { ok: true };
  }
}

/**
 * A controller carrying a CLASS-LEVEL permission, with one handler overriding
 * it. Carry-forward ruling 61's shape: the decorator is `MethodDecorator &
 * ClassDecorator` on purpose here — unlike the exemptions — so the class-level
 * case is behaviour to pin rather than a hole to close.
 */
@Controller('scoped')
@RequirePermission('billing.manage')
class ClassScopedController {
  @Get('inherits')
  inherits(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('organization.read')
  @Get('overrides')
  overrides(): { ok: true } {
    return { ok: true };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function bootAs(
  tenant: TenantContext | null,
  controllers: readonly (typeof ProbeController | typeof ClassScopedController)[] = [
    ProbeController,
  ],
): Promise<NestExpressApplication> {
  const built = await buildGuardedApp({
    controllers,
    providers: [
      Reflector,
      { provide: TENANT_STUB, useValue: tenant },
      {
        provide: APP_GUARD,
        inject: [TENANT_STUB],
        useFactory: (value: TenantContext | null) => new FakeTenantGuard(value),
      },
      { provide: APP_GUARD, useClass: AuthorizationGuard },
      { provide: APP_GUARD, useClass: EntitlementGuard },
    ],
  });
  app = built;
  return built;
}

describe('AuthorizationGuard', () => {
  it('ignores a public route even when no tenant resolved', async () => {
    const built = await bootAs(null);
    await request(built.getHttpServer()).get('/api/v1/probe/public').expect(200);
  });

  it('ignores an @AuthenticatedOnly() route even when no tenant resolved', async () => {
    const built = await bootAs(null);
    await request(built.getHttpServer()).get('/api/v1/probe/authenticated').expect(200);
  });

  it('admits a caller whose role holds the declared permission', async () => {
    const built = await bootAs(contextWith('MEMBER'));
    const response = await request(built.getHttpServer()).get('/api/v1/probe/scan-create');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ role: 'MEMBER' });
  });

  it('refuses a caller whose role does not hold it, with 403 PERMISSION_DENIED', async () => {
    const built = await bootAs(contextWith('MEMBER'));
    const response = await request(built.getHttpServer()).get('/api/v1/probe/accept-risk');
    expect(response.status).toBe(403);
    expect(codeOf(response.body)).toBe('PERMISSION_DENIED');
  });

  /**
   * `api/authorization.md` §4: a 403 "states which permission is missing and
   * who can grant it, so the user can act rather than file a ticket". The
   * roles list is checked against `product/permissions.md`'s own table via the
   * contracts constant the document is asserted against.
   */
  it('names the permission, the caller’s role, and the roles that hold it', async () => {
    const built = await bootAs(contextWith('MEMBER'));
    const response = await request(built.getHttpServer()).get('/api/v1/probe/accept-risk');
    expect(envelopeOf(response.body).error.details).toEqual({
      required: 'finding.accept_risk',
      yourRole: 'MEMBER',
      rolesWithPermission: ['OWNER', 'ADMIN', 'SECURITY_LEAD'],
    });
  });

  /**
   * §4's limit, and it is the half that is a disclosure rule rather than a
   * usability one: "We never list *which users* hold the permission — that is
   * organisation membership detail the caller may not be entitled to."
   */
  it('never names a user, an id, or a membership in the refusal', async () => {
    const built = await bootAs(contextWith('MEMBER'));
    const response = await request(built.getHttpServer()).get('/api/v1/probe/accept-risk');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('usr_');
    expect(body).not.toContain('mbr_');
    expect(body).not.toContain('org_');
  });

  /**
   * FAIL CLOSED, AND FAIL AS A 404. Reaching this guard with no tenant means the
   * pipeline is not the one the file believes. Answering 403 there would turn a
   * misconfiguration into an existence oracle, which is what
   * `security/authorization.md` §6 exists to prevent.
   */
  it('refuses a permission route with 404 when no tenant resolved at all', async () => {
    const built = await bootAs(null);
    const response = await request(built.getHttpServer()).get('/api/v1/probe/scan-create');
    expect(response.status).toBe(404);
    expect(codeOf(response.body)).toBe('RESOURCE_NOT_FOUND');
  });

  it('applies a class-level permission to a handler that declares none', async () => {
    const built = await bootAs(contextWith('ADMIN'), [ClassScopedController]);
    // ADMIN does not hold `billing.manage` — `product/permissions.md` gives it
    // to OWNER alone — so inheritance is proved by the refusal naming it.
    const response = await request(built.getHttpServer()).get('/api/v1/scoped/inherits');
    expect(response.status).toBe(403);
    expect(envelopeOf(response.body).error.details?.required).toBe('billing.manage');
  });

  it('lets a handler-level permission override the class-level one', async () => {
    const built = await bootAs(contextWith('ADMIN'), [ClassScopedController]);
    await request(built.getHttpServer()).get('/api/v1/scoped/overrides').expect(200);
  });

  /**
   * A fourth arm added to `AccessDeclaration` must be IGNORED here, not
   * authorised. The guard matches `kind === 'permission'` positively rather
   * than excluding `public`, and this is what holds it there — written with a
   * raw `SetMetadata` because the union has no fourth arm to write in TypeScript.
   */
  it('ignores an access declaration whose kind it does not recognise', async () => {
    @Controller('future')
    class FutureController {
      @SetMetadata(ACCESS_METADATA_KEY, { kind: 'something-later' })
      @Get('route')
      route(): { ok: true } {
        return { ok: true };
      }
    }
    const built = await buildGuardedApp({
      controllers: [FutureController],
      providers: [
        Reflector,
        { provide: APP_GUARD, useFactory: () => new FakeTenantGuard(null) },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
      ],
    });
    app = built;
    await request(built.getHttpServer()).get('/api/v1/future/route').expect(200);
  });
});

describe('EntitlementGuard — the Phase 10 stub', () => {
  it('admits a request every other layer admitted', async () => {
    const built = await bootAs(contextWith('OWNER'));
    await request(built.getHttpServer()).get('/api/v1/probe/scan-create').expect(200);
  });

  it('does not rescue a request an earlier layer refused', async () => {
    // A stub that allows everything must not be readable as "the pipeline
    // allows everything". It runs last, so a 403 from layer 4 still stands.
    const built = await bootAs(contextWith('VIEWER'));
    await request(built.getHttpServer()).get('/api/v1/probe/scan-create').expect(403);
  });
});
