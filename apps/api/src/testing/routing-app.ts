import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { applyRouting } from '../app-setup.js';

/**
 * An application containing nothing but the given controllers, routed exactly
 * the way production routes.
 *
 * Purpose-built controllers rather than the real `AppModule`: the route
 * inventory and the boot-time access assertion have to be provable against a
 * route that is *missing* its declaration, and no such route exists in this
 * codebase — the assertion is what stops one existing. Building a two-line
 * offender here is the only way to watch the check actually fail.
 *
 * The graph touches no Postgres, Redis or S3, so this belongs in the unit lane;
 * anything that needs the real module graph uses `build-app.ts` and the
 * integration lane instead.
 *
 * Deliberately **not** initialised: `app.init()` is what registers routes, and
 * whether the caller remembered to run it is itself under test.
 */
export async function buildRoutingApp(
  controllers: readonly Type[],
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [...controllers],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  applyRouting(app);
  return app;
}
