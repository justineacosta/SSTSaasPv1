import { describe, expect, it } from 'vitest';
import { RequestMethod, type MiddlewareConsumer } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware.js';

interface Registration {
  readonly middleware: unknown[];
  readonly routes: unknown[];
}

function recordMiddleware(): { consumer: MiddlewareConsumer; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const consumer = {
    apply: (...middleware: unknown[]) => ({
      forRoutes: (...routes: unknown[]) => {
        registrations.push({ middleware, routes });
        return consumer;
      },
      exclude: () => ({ forRoutes: () => consumer }),
    }),
  } as unknown as MiddlewareConsumer;
  return { consumer, registrations };
}

describe('AppModule middleware pipeline', () => {
  // architecture/backend.md §3: "Order matters and is asserted by a test." This
  // is that test for the two stages that exist. Each guard stage added later
  // extends the expected sequence here, so a stage inserted in the wrong place
  // — authentication after authorization, say — cannot land quietly.
  it('runs the request ID middleware before the security headers middleware', () => {
    const { consumer, registrations } = recordMiddleware();
    new AppModule().configure(consumer);

    const order = registrations.flatMap((registration) => registration.middleware);
    expect(order).toEqual([RequestIdMiddleware, SecurityHeadersMiddleware]);
  });

  it('applies both to every route and method, not to a subset', () => {
    const { consumer, registrations } = recordMiddleware();
    new AppModule().configure(consumer);

    expect(registrations).toHaveLength(1);
    // A path filter here is how a security header quietly stops covering an
    // endpoint added later.
    expect(registrations[0]!.routes).toEqual([{ path: '*splat', method: RequestMethod.ALL }]);
  });
});
