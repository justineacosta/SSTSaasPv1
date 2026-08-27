import 'reflect-metadata';
import type { Provider, Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createLogger } from '@sentinel/observability';
import { applyRouting } from '../app-setup.js';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter.js';

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

/**
 * The same purpose-built application, plus providers and the global exception
 * filter, for proving a **guard**.
 *
 * A guard's observable behaviour is a status code and an error envelope, and
 * neither exists without the filter that turns a `DomainError` into one. This
 * builds the smallest application in which that is true: real routing, real
 * filter, real guards, and controllers that exist nowhere in the product.
 *
 * Still the unit lane. The graph touches no Postgres, Redis or S3 — the session
 * service is supplied as a stub through `providers` — so nothing here needs
 * Docker. A guard spec that wanted the real `SessionService` would use
 * `build-app.ts` and the integration lane instead, and
 * `authentication.integration.spec.ts` does exactly that for the properties
 * that need a real session.
 *
 * **Initialised here, unlike `buildRoutingApp`.** That function leaves
 * `app.init()` to the caller because whether the caller remembered to run it is
 * itself under test in `access-assertion.spec.ts`. Nothing about a guard is
 * served by repeating that.
 */
export async function buildGuardedApp(options: {
  controllers: readonly Type[];
  providers?: readonly Provider[] | undefined;
}): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [...options.controllers],
    providers: [...(options.providers ?? [])],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  applyRouting(app);
  app.useGlobalFilters(
    new AllExceptionsFilter(
      createLogger({ service: 'test', level: 'fatal', pretty: false, silent: true }),
    ),
  );
  await app.init();
  return app;
}
