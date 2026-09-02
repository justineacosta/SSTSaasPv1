import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  errorEnvelopeSchema,
  type ErrorEnvelope,
  type Permission,
  type TenantContext,
} from '@sentinel/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGuardedApp } from '../../testing/routing-app.js';
import { AuthenticatedOnly, RequirePermission } from './access.decorator.js';
import { Ctx } from './ctx.decorator.js';

/**
 * The refusal, parsed through the published envelope rather than read off an
 * `any`. `errorEnvelopeSchema` is the contract `AllExceptionsFilter` produces,
 * so a body that does not match it fails here rather than surviving as
 * `undefined === undefined`.
 */
const envelopeOf = (body: unknown): ErrorEnvelope => errorEnvelopeSchema.parse(body);
const codeOf = (body: unknown): string => envelopeOf(body).error.code;

const TENANT: TenantContext = {
  organizationId: 'org_01J000000000000000000001',
  membershipId: 'mbr_01J000000000000000000001',
  roleKey: 'SECURITY_LEAD',
  permissions: new Set<Permission>(['organization.read', 'scan.create']),
};

class FakeTenantGuard {
  constructor(private readonly tenant: TenantContext | null) {}
  canActivate(context: { switchToHttp: () => { getRequest: () => unknown } }): boolean {
    const req = context.switchToHttp().getRequest() as { tenant?: TenantContext };
    if (this.tenant !== null) req.tenant = this.tenant;
    return true;
  }
}

@Controller('ctx')
class CtxController {
  @RequirePermission('organization.read')
  @Get('resolved')
  resolved(@Ctx() ctx: TenantContext): {
    organizationId: string;
    roleKey: string;
    permissions: string[];
  } {
    return {
      organizationId: ctx.organizationId,
      roleKey: ctx.roleKey,
      permissions: [...ctx.permissions].sort(),
    };
  }

  /**
   * A handler that reads `@Ctx()` on a route where the tenant can legitimately
   * be absent. This is the misuse the decorator exists to make loud, so the
   * fixture is deliberately wrong.
   */
  @AuthenticatedOnly()
  @Get('unresolved')
  unresolved(@Ctx() ctx: TenantContext): { organizationId: string } {
    return { organizationId: ctx.organizationId };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(tenant: TenantContext | null): Promise<NestExpressApplication> {
  const built = await buildGuardedApp({
    controllers: [CtxController],
    providers: [Reflector, { provide: APP_GUARD, useFactory: () => new FakeTenantGuard(tenant) }],
  });
  app = built;
  return built;
}

describe('@Ctx()', () => {
  it('hands the handler the resolved TenantContext', async () => {
    const built = await boot(TENANT);
    const response = await request(built.getHttpServer()).get('/api/v1/ctx/resolved');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      organizationId: 'org_01J000000000000000000001',
      roleKey: 'SECURITY_LEAD',
      permissions: ['organization.read', 'scan.create'],
    });
  });

  /**
   * THE FAILURE IS LOUD AND IT IS A 500, DELIBERATELY.
   *
   * The alternatives are both worse than throwing: a nullable type would make
   * every guarded handler write a branch that cannot be taken and cannot be
   * tested, and a fabricated empty context would hand a handler a tenant scope
   * of "nothing" — which reads as an ordinary empty result rather than as a
   * misconfiguration. A 500 is the correct answer to "this application is wired
   * wrong", and `AllExceptionsFilter` keeps the detail server-side.
   */
  it('throws rather than handing back undefined when no tenant resolved', async () => {
    const built = await boot(null);
    const response = await request(built.getHttpServer()).get('/api/v1/ctx/unresolved');
    expect(response.status).toBe(500);
    expect(codeOf(response.body)).toBe('INTERNAL_ERROR');
  });

  it('leaks nothing about the misconfiguration to the client', async () => {
    // `api/errors.md`: never leak internals. The explanatory message in
    // `ctx.decorator.ts` is for a log line and a stack trace, not for a caller.
    const built = await boot(null);
    const response = await request(built.getHttpServer()).get('/api/v1/ctx/unresolved');
    expect(JSON.stringify(response.body)).not.toContain('TenantContextGuard');
    expect(JSON.stringify(response.body)).not.toContain('@Ctx()');
  });
});
