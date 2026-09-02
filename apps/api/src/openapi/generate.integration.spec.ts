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
import { detailedReportSchema, readinessReportSchema } from '../modules/health/health.contracts.js';
import { buildApp } from '../testing/build-app.js';
import { generateOpenApiDocument, toOpenApiPath } from './generate.js';

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

  it('matches it byte for byte, not merely in structure', () => {
    // `toEqual` above is blind to key order and to formatting, so a
    // regeneration that only reordered keys would satisfy it and still produce
    // a diff in the CI gate that Task 14 adds. This test and that gate have to
    // agree about what "matches" means, so this compares the exact bytes
    // `cli.ts` writes. `.gitattributes` pins checkouts to LF, so the newline is
    // stable across platforms.
    const serialised = `${JSON.stringify(generateOpenApiDocument(app), null, 2)}
`;
    expect(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')).toBe(serialised);
  });

  it('documents every registered route', () => {
    const document = generateOpenApiDocument(app);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/health/detailed']),
    );

    // Stronger than the containment check above, and the reason drift is
    // impossible: the document's path list is compared against Express's own
    // router, so a route that exists but is undocumented fails here.
    //
    // **The router's side is translated, not the document's.** Express registers
    // `/api/v1/organizations/:id`; OpenAPI templates the same segment as
    // `{id}`, and the document must carry the OpenAPI spelling or no validator
    // or client generator can read it. Comparing raw strings would force one of
    // the two to be wrong, so `toOpenApiPath` — the same function the generator
    // uses — is applied to the router's list before the comparison.
    //
    // Applying the generator's own function to both sides would make this
    // vacuous, which is why it is applied to ONE side: the document keeps
    // whatever the generator produced, and if that ever stopped being the
    // OpenAPI spelling the two lists would diverge here.
    const documented = Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const registered = registeredRouterRoutes(app)
      .map((entry) => {
        const [method, ...rest] = entry.split(' ');
        return `${String(method)} ${toOpenApiPath(rest.join(' '))}`;
      })
      .sort();
    expect(documented).toEqual(registered);
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

describe('the published health schemas describe the bodies actually served', () => {
  /**
   * Closes the one direction `health.contracts.ts`'s `z.ZodType<T>` annotations
   * cannot.
   *
   * That annotation catches a field added to `ReadinessReport` and forgotten in
   * the schema — it stops compiling. It does **not** catch the reverse: a field
   * added to the *schema* that the handler never returns stays assignable, and
   * would publish an OpenAPI document promising a field the API does not send.
   * Parsing the served body with the schema is what fails in that direction,
   * because a required key the response lacks is a Zod error.
   *
   * Deliberately parsed against the schema rather than compared to a
   * hand-written key list: a key list is a third copy of the shape, and would
   * drift from both.
   */
  it('/health/ready returns exactly what readinessReportSchema requires', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(() => readinessReportSchema.parse(response.body as unknown)).not.toThrow();
  });

  it('/health/detailed returns exactly what detailedReportSchema requires', async () => {
    const response = await request(app.getHttpServer()).get('/health/detailed').expect(200);
    expect(() => detailedReportSchema.parse(response.body as unknown)).not.toThrow();
  });
});
