import type { INestApplication } from '@nestjs/common';
import {
  byMethodThenPath,
  describeRoutes,
  registeredRouterRoutes,
  type RouteDescriptor,
} from './route-inventory.js';

export type { RouteDescriptor };

const DOCUMENT_REFERENCE = 'See .claude/architecture/backend.md §3.';

/**
 * Every route that declares neither `@Public()` nor `@RequirePermission()`.
 *
 * Returns all of them rather than the first, because a boot that reports one
 * offender at a time turns a ten-route mistake into ten restarts.
 */
export function findRoutesWithoutAccessDeclaration(
  routes: readonly RouteDescriptor[],
): RouteDescriptor[] {
  return routes.filter((route) => route.access === undefined);
}

function formatOffenders(offenders: readonly RouteDescriptor[]): string {
  const sorted = [...offenders].sort(byMethodThenPath);
  const pathWidth = Math.max(...sorted.map((route) => route.path.length));
  return [
    `Startup refused: ${sorted.length} route(s) declare no access requirement.`,
    '',
    ...sorted.map(
      (route) =>
        `  ${route.method.padEnd(6)} ${route.path.padEnd(pathWidth)}   ${route.controller}.${route.handler}`,
    ),
    '',
    'Every route must declare @Public() or @RequirePermission(...). Missing',
    'authorization is a boot failure here rather than a production discovery.',
    DOCUMENT_REFERENCE,
  ].join('\n');
}

function assertInventoryMatchesRouter(
  routes: readonly RouteDescriptor[],
  registered: readonly string[],
): void {
  const described = new Set(routes.map((route) => `${route.method} ${route.path}`));
  const registeredSet = new Set(registered);
  const undescribed = [...registeredSet].filter((route) => !described.has(route)).sort();
  const unregistered = [...described].filter((route) => !registeredSet.has(route)).sort();
  if (undescribed.length === 0 && unregistered.length === 0) return;

  throw new Error(
    [
      'Startup refused: the checked route inventory does not match the routes Nest registered.',
      '',
      ...(undescribed.length === 0
        ? []
        : ['  Registered but not checked:', ...undescribed.map((route) => `    ${route}`)]),
      ...(unregistered.length === 0
        ? []
        : ['  Checked but not registered:', ...unregistered.map((route) => `    ${route}`)]),
      '',
      'The access check reads controller metadata; this compares that reading against',
      "Express's own router. A mismatch means the check is inspecting something other",
      'than the application that is about to serve traffic, so its result means nothing.',
      DOCUMENT_REFERENCE,
    ].join('\n'),
  );
}

/**
 * A route without an explicit access declaration crashes startup.
 *
 * This lands in Phase 1, with one module, on purpose. Added in Phase 2 with
 * thirty routes already written, it would start life with a backlog of
 * offenders and get commented out on the first bad afternoon.
 *
 * **Call this after `await app.init()`, never merely "before `listen`".** Nest
 * registers no route until `init()` runs, and `listen()` runs it implicitly, so
 * an assertion placed immediately before `listen` inspects an empty router and
 * passes without checking anything — a boot check that cannot fail is worse
 * than no boot check, because it is believed. The empty-router guard below
 * exists so that mistake is a loud failure rather than a silent pass.
 */
export function assertEveryRouteDeclaresAccess(app: INestApplication): void {
  const registered = registeredRouterRoutes(app);
  if (registered.length === 0) {
    throw new Error(
      [
        'Startup refused: no routes are registered, so this assertion would pass',
        'without checking anything.',
        '',
        'Nest registers routes during `app.init()`, which `app.listen()` calls',
        'implicitly — call `await app.init()` first, then assert, then listen.',
        DOCUMENT_REFERENCE,
      ].join('\n'),
    );
  }

  const routes = describeRoutes(app);
  assertInventoryMatchesRouter(routes, registered);

  const offenders = findRoutesWithoutAccessDeclaration(routes);
  if (offenders.length > 0) throw new Error(formatOffenders(offenders));
}
