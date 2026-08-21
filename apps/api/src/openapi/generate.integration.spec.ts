import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  assertEveryRouteDeclaresAccess,
  findRoutesWithoutAccessDeclaration,
} from '../common/access-assertion.js';
import { describeRoutes, registeredRouterRoutes } from '../common/route-inventory.js';
import { buildApp } from '../testing/build-app.js';
import { generateOpenApiDocument } from './generate.js';

/**
 * The real application, with every module, routed by the real `configureApp`.
 *
 * The unit lane proves these functions behave correctly on inputs it
 * constructs. This proves they see *this* application — the one that serves
 * traffic — which is the half a hand-built fixture can never establish.
 */
let app: NestExpressApplication;

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('the boot-time access assertion, against the real application', () => {
  it('sees a non-empty inventory containing the routes this API actually has', () => {
    const paths = describeRoutes(app).map((route) => route.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/health/live',
        '/health/ready',
        '/health/detailed',
        '/api/v1/openapi.json',
      ]),
    );
    // And the inventory is the router's, not a hopeful description of it.
    expect(
      describeRoutes(app)
        .map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual(registeredRouterRoutes(app));
  });

  it('passes, because every route in this application declares its access', () => {
    expect(findRoutesWithoutAccessDeclaration(describeRoutes(app))).toEqual([]);
    expect(() => {
      assertEveryRouteDeclaresAccess(app);
    }).not.toThrow();
  });
});

describe('the OpenAPI document', () => {
  it('the committed openapi.json matches what the code generates', () => {
    // The whole point of committing it: `pnpm --filter @sentinel/api
    // openapi:generate` is the only way this file changes, so a contract change
    // arrives as a reviewable diff rather than as a surprise for a client.
    const generated = generateOpenApiDocument(app);
    const committed = JSON.parse(
      readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(generated).toEqual(committed);
  });

  it('documents every registered route', () => {
    const document = generateOpenApiDocument(app);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/health/detailed']),
    );

    // Stronger than the containment check above, and the reason drift is
    // impossible: the document's path list is compared against Express's own
    // router, so a route that exists but is undocumented fails here.
    const documented = Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    expect(documented).toEqual(registeredRouterRoutes(app));
  });

  it('is served, unauthenticated, at /api/v1/openapi.json', () => {
    return request(app.getHttpServer())
      .get('/api/v1/openapi.json')
      .expect(200)
      .expect((response: { body: unknown }) => {
        expect(response.body).toEqual(generateOpenApiDocument(app));
      });
  });
});
