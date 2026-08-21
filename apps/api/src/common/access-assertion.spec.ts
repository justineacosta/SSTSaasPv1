import { describe, expect, it } from 'vitest';
import { Controller, Delete, Get, Post } from '@nestjs/common';
import { buildRoutingApp } from '../testing/routing-app.js';
import { Public, RequirePermission } from './decorators/access.decorator.js';
import {
  assertEveryRouteDeclaresAccess,
  findRoutesWithoutAccessDeclaration,
  type RouteDescriptor,
} from './access-assertion.js';

const route = (over: Partial<RouteDescriptor>): RouteDescriptor => ({
  controller: 'HealthController',
  handler: 'live',
  method: 'GET',
  path: '/health/live',
  access: undefined,
  ...over,
});

describe('findRoutesWithoutAccessDeclaration', () => {
  it('passes when every route declares its access', () => {
    expect(
      findRoutesWithoutAccessDeclaration([
        route({ access: { kind: 'public' } }),
        route({ handler: 'list', access: { kind: 'permission', permission: 'finding.read' } }),
      ]),
    ).toEqual([]);
  });

  it('reports a route with no declaration', () => {
    const offender = route({ controller: 'FindingsController', handler: 'destroy' });
    expect(findRoutesWithoutAccessDeclaration([offender])).toEqual([offender]);
  });

  it('lists every offender, not just the first — one boot should reveal all of them', () => {
    const offenders = [route({ handler: 'a' }), route({ handler: 'b' }), route({ handler: 'c' })];
    expect(
      findRoutesWithoutAccessDeclaration([...offenders, route({ access: { kind: 'public' } })]),
    ).toHaveLength(3);
  });

  it('treats @Public as a declaration, not as an absence of one', () => {
    expect(findRoutesWithoutAccessDeclaration([route({ access: { kind: 'public' } })])).toEqual([]);
  });
});

/**
 * Everything below runs the assertion against a real Nest application.
 *
 * The pure tests above can only prove that a list is filtered correctly. They
 * say nothing about whether the list is ever populated — and an assertion that
 * inspects zero routes passes every time, which is the failure mode this whole
 * task exists to avoid. These build an application containing a route that is
 * genuinely undeclared and watch the check refuse to start.
 */
@Controller('declared')
class DeclaredController {
  @Public()
  @Get()
  list(): string {
    return 'ok';
  }

  @RequirePermission('finding.read')
  @Get(':id')
  one(): string {
    return 'ok';
  }
}

@Controller('findings')
class FindingsController {
  @Public()
  @Get()
  list(): string {
    return 'ok';
  }

  @Delete(':id')
  destroy(): string {
    return 'ok';
  }

  @Post()
  create(): string {
    return 'ok';
  }
}

const messageOf = (act: () => void): string => {
  try {
    act();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected assertEveryRouteDeclaresAccess to throw, and it did not.');
};

describe('assertEveryRouteDeclaresAccess', () => {
  it('refuses a router with no routes rather than passing vacuously', async () => {
    // The trap, made into a test. Nest registers nothing until `init()` runs,
    // and `listen()` runs it implicitly — so an assertion written "immediately
    // before listen" would look at an empty router and approve it. Without this
    // guard the whole control is decorative.
    const app = await buildRoutingApp([FindingsController]);
    try {
      const message = messageOf(() => {
        assertEveryRouteDeclaresAccess(app);
      });
      expect(message).toContain('would pass');
      expect(message).toContain('app.init()');
    } finally {
      await app.close();
    }
  });

  it('accepts an application whose every route declares its access', async () => {
    const app = await buildRoutingApp([DeclaredController]);
    await app.init();
    try {
      expect(() => {
        assertEveryRouteDeclaresAccess(app);
      }).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('refuses to start, naming every undeclared route and where it lives', async () => {
    const app = await buildRoutingApp([DeclaredController, FindingsController]);
    await app.init();
    try {
      const message = messageOf(() => {
        assertEveryRouteDeclaresAccess(app);
      });

      expect(message).toContain('Startup refused: 2 route(s) declare no access requirement.');
      expect(message).toContain('DELETE /api/v1/findings/:id   FindingsController.destroy');
      expect(message).toContain('POST   /api/v1/findings       FindingsController.create');
      // The declared routes are not in the report, including the sibling
      // handler on the very same controller.
      expect(message).not.toContain('FindingsController.list');
      expect(message).not.toContain('DeclaredController');
      expect(message).toContain('.claude/architecture/backend.md §3');
    } finally {
      await app.close();
    }
  });

  it('refuses when a route exists that the check cannot see', async () => {
    // A route registered straight onto Express carries no controller metadata,
    // so the inventory misses it entirely. Without the router cross-check the
    // assertion would happily approve an application containing an endpoint it
    // never looked at.
    const app = await buildRoutingApp([DeclaredController]);
    await app.init();
    const express = app.getHttpAdapter().getInstance() as unknown as {
      get: (path: string, handler: () => void) => void;
    };
    express.get('/rogue', () => {});
    try {
      const message = messageOf(() => {
        assertEveryRouteDeclaresAccess(app);
      });
      expect(message).toContain('does not match the routes Nest registered');
      expect(message).toContain('GET /rogue');
    } finally {
      await app.close();
    }
  });

  it('refuses a rogue route even when its path is not a string', async () => {
    // The same scenario as above with a RegExp instead of a string. Express
    // accepts one; the inventory can never produce one; so filtering it out
    // would have left the cross-check — the last line of defence — with a blind
    // spot exactly where out-of-band registration lives.
    const app = await buildRoutingApp([DeclaredController]);
    await app.init();
    const express = app.getHttpAdapter().getInstance() as unknown as {
      get: (path: RegExp, handler: () => void) => void;
    };
    express.get(/rogue/, () => {});
    try {
      const message = messageOf(() => {
        assertEveryRouteDeclaresAccess(app);
      });
      expect(message).toContain('does not match the routes Nest registered');
      expect(message).toContain('<unrecognised path: rogue>');
    } finally {
      await app.close();
    }
  });
});
