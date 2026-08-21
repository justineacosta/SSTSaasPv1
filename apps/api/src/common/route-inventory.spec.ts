import { describe, expect, it } from 'vitest';
import { Controller, Delete, Get, Post, VERSION_NEUTRAL, Version } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { buildRoutingApp } from '../testing/routing-app.js';
import { Public, RequirePermission } from './decorators/access.decorator.js';
import { ApiDoc } from './decorators/openapi.decorator.js';
import { describeRoutes, registeredRouterRoutes } from './route-inventory.js';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
class ProbeController {
  @Public()
  @Get('live')
  live(): string {
    return 'ok';
  }
}

@RequirePermission('finding.read')
@Controller('findings')
class FindingsController {
  @Get()
  @ApiDoc({ summary: 'Lists findings.', responses: [] })
  list(): string {
    return 'ok';
  }

  @Get(':id')
  one(): string {
    return 'ok';
  }

  @RequirePermission('finding.delete')
  @Delete(':id')
  destroy(): string {
    return 'ok';
  }

  @Version('2')
  @Post()
  create(): string {
    return 'ok';
  }

  /** Not a route: no HTTP method decorator, so it must not appear. */
  helper(): string {
    return 'ok';
  }
}

const withApp = async (
  body: (app: NestExpressApplication) => void | Promise<void>,
): Promise<void> => {
  const app = await buildRoutingApp([ProbeController, FindingsController]);
  await app.init();
  try {
    await body(app);
  } finally {
    await app.close();
  }
};

describe('describeRoutes', () => {
  it('reports the same routes Express registered, with the same paths', async () => {
    // The one assertion that matters: the inventory is derived from decorator
    // metadata, and metadata is exactly what survives when routing breaks. If
    // these two ever disagree, the access assertion is checking a fiction.
    await withApp((app) => {
      const described = describeRoutes(app)
        .map((route) => `${route.method} ${route.path}`)
        .sort();
      expect(described).toEqual(registeredRouterRoutes(app));
      expect(described).toEqual([
        'DELETE /api/v1/findings/:id',
        'GET /api/v1/findings',
        'GET /api/v1/findings/:id',
        'GET /health/live',
        'POST /api/v2/findings',
      ]);
    });
  });

  it('applies the global prefix, its health exclusion, and the version segment', async () => {
    await withApp((app) => {
      const paths = describeRoutes(app).map((route) => route.path);
      // Version-neutral and prefix-excluded, exactly as production routes it.
      expect(paths).toContain('/health/live');
      // A method-level @Version overrides the controller's default.
      expect(paths).toContain('/api/v2/findings');
    });
  });

  it('reads a class-level declaration and lets a handler override it', async () => {
    await withApp((app) => {
      const routes = describeRoutes(app);
      const byHandler = (handler: string) => routes.find((route) => route.handler === handler);

      expect(byHandler('live')?.access).toEqual({ kind: 'public' });
      expect(byHandler('list')?.access).toEqual({ kind: 'permission', permission: 'finding.read' });
      expect(byHandler('destroy')?.access).toEqual({
        kind: 'permission',
        permission: 'finding.delete',
      });
    });
  });

  it('carries the OpenAPI declaration and omits methods that are not routes', async () => {
    await withApp((app) => {
      const routes = describeRoutes(app);
      expect(routes.find((route) => route.handler === 'list')?.doc?.summary).toBe(
        'Lists findings.',
      );
      expect(routes.find((route) => route.handler === 'one')?.doc).toBeUndefined();
      expect(routes.some((route) => route.handler === 'helper')).toBe(false);
    });
  });

  it('names the controller class and the handler method', async () => {
    await withApp((app) => {
      expect(describeRoutes(app)).toContainEqual(
        expect.objectContaining({
          controller: 'FindingsController',
          handler: 'destroy',
          method: 'DELETE',
          path: '/api/v1/findings/:id',
        }),
      );
    });
  });
});

describe('registeredRouterRoutes', () => {
  it('is empty before init, which is what makes the boot-order guard necessary', async () => {
    const app = await buildRoutingApp([ProbeController]);
    try {
      expect(registeredRouterRoutes(app)).toEqual([]);
      await app.init();
      expect(registeredRouterRoutes(app)).toEqual(['GET /health/live']);
    } finally {
      await app.close();
    }
  });
});
