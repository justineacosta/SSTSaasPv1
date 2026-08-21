import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
// `VERSION_METADATA` and `VersionValue` are not on `@nestjs/common`'s barrel,
// only on these two — the same subpaths Nest's own router reads them from.
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants.js';
import type { VersionValue } from '@nestjs/common/interfaces/index.js';
import { ApplicationConfig, DiscoveryService, MetadataScanner } from '@nestjs/core';
// Not part of `@nestjs/core`'s public index, and imported here on purpose.
// This class *is* the path assembly Nest's own router uses — global prefix,
// prefix exclusions, URI version segment, slash normalisation. The alternative
// was a second implementation of the same 60 lines, which is exactly the drift
// architecture/backend.md §3 asks this assertion to prevent. If a Nest upgrade
// moves the file, the API fails to start rather than starting with a silently
// wrong inventory.
//
// It is only *half* of what Nest does, though: the router then registers
// `adapter.normalizePath(path)` (`router-explorer.js`), which is why every
// caller must supply that step too — see `PathNormaliser` below.
import { RoutePathFactory } from '@nestjs/core/router/route-path-factory.js';
import { ACCESS_METADATA_KEY, type AccessDeclaration } from './decorators/access.decorator.js';
import { OPENAPI_METADATA_KEY, type ApiDocDeclaration } from './decorators/openapi.decorator.js';

/** One HTTP route, as the boot-time access assertion reports it. */
export interface RouteDescriptor {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly access: AccessDeclaration | undefined;
}

/**
 * A route plus everything else read off it in the same pass.
 *
 * One walk, two readers: the access assertion and the OpenAPI generator both
 * describe "the routes this application has", and two independent walks would
 * eventually disagree about which routes those are.
 */
export interface RegisteredRoute extends RouteDescriptor {
  readonly doc: ApiDocDeclaration | undefined;
}

/**
 * The subset of a controller class this module touches. Written out rather than
 * using `InstanceWrapper['metatype']` (`Type<any> | Function | null`) so the
 * `any` never enters, and so the two members actually read are visible.
 */
interface ControllerClass {
  readonly name: string;
  readonly prototype: object;
}

const asPaths = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
};

/**
 * The second half of Nest's path assembly.
 *
 * `RoutePathFactory` builds the path; the router then registers
 * `adapter.normalizePath(path)`, and the Express adapter's implementation runs
 * `LegacyRouteConverter.tryConvert`, which rewrites legacy syntax — `*` becomes
 * `{*path}`, `+` becomes `*path`, `(.*)` becomes `{*path}`. For a path with no
 * legacy syntax it is the identity, which is why the four routes this API has
 * today would not notice its absence.
 *
 * The first `@Get('*')` anyone writes would notice: the inventory would hold
 * `/api/v1/x/*`, Express would hold `/api/v1/x/{*path}`, and
 * `assertEveryRouteDeclaresAccess` would refuse to boot a perfectly valid route
 * with a message blaming the checker. A security control that fails that way on
 * a legal route is a security control someone switches off.
 *
 * Required rather than defaulted to the identity: a default is how a caller
 * silently gets the wrong answer, and there are only two callers.
 */
export type PathNormaliser = (path: string) => string;

/**
 * The normaliser for an application's own HTTP adapter.
 *
 * `normalizePath` is optional on the `HttpServer` interface; an adapter without
 * one registers paths verbatim, so the identity is the correct fallback rather
 * than a guess.
 */
export const adapterPathNormaliser =
  (adapter: { normalizePath?: (path: string) => string }): PathNormaliser =>
  (path) =>
    adapter.normalizePath?.(path) ?? path;

/**
 * Builds the route inventory from controller metadata.
 *
 * Takes its collaborators rather than the application so that the
 * `/api/v1/openapi.json` handler — which has these injected but no
 * `INestApplication` — can call it too. All three are ordinary providers: Nest
 * registers `ApplicationConfig` in every module, `DiscoveryService` comes from
 * `DiscoveryModule`, and `HttpAdapterHost` supplies the normaliser.
 *
 * Between `RoutePathFactory` and `normalizePath` this reproduces both halves of
 * what Nest's router does with a path, so the inventory agrees with the routes
 * Nest registered. That agreement is asserted rather than assumed:
 * `assertEveryRouteDeclaresAccess` compares this result against Express's own
 * router on every boot, and refuses to start on any difference.
 */
export function describeRoutesFrom(
  discovery: DiscoveryService,
  config: ApplicationConfig,
  normalizePath: PathNormaliser,
): RegisteredRoute[] {
  const factory = new RoutePathFactory(config);
  const scanner = new MetadataScanner();
  const versioningOptions = config.getVersioning();
  const globalPrefix = config.getGlobalPrefix();
  const routes: RegisteredRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as ControllerClass | null | undefined;
    if (controller === null || controller === undefined) continue;

    const controllerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
    // Nest resolves a controller's version to the configured default when the
    // controller declares none — see `RoutesResolver#getVersionMetadata`. A
    // route inventory that skipped that step would report `/api/things` for a
    // controller Nest publishes at `/api/v1/things`.
    const controllerVersion =
      versioningOptions === undefined
        ? undefined
        : ((Reflect.getMetadata(VERSION_METADATA, controller) as VersionValue | undefined) ??
          versioningOptions.defaultVersion);

    for (const handlerName of scanner.getAllMethodNames(controller.prototype)) {
      const handler: unknown = (controller.prototype as Record<string, unknown>)[handlerName];
      if (typeof handler !== 'function') continue;

      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      const methodPaths = asPaths(Reflect.getMetadata(PATH_METADATA, handler));
      if (requestMethod === undefined || methodPaths.length === 0) continue;

      // Method metadata wins over class metadata, matching how Nest's own
      // `Reflector.getAllAndOverride` resolves a decorator applied at both
      // levels — a `@Public()` handler inside a `@RequirePermission()`
      // controller is public.
      const access = (Reflect.getMetadata(ACCESS_METADATA_KEY, handler) ??
        Reflect.getMetadata(ACCESS_METADATA_KEY, controller)) as AccessDeclaration | undefined;
      const doc = Reflect.getMetadata(OPENAPI_METADATA_KEY, handler) as
        ApiDocDeclaration | undefined;
      const methodVersion = Reflect.getMetadata(VERSION_METADATA, handler) as
        VersionValue | undefined;

      for (const ctrlPath of controllerPaths) {
        for (const methodPath of methodPaths) {
          const paths = factory.create(
            {
              ctrlPath,
              methodPath,
              globalPrefix,
              // Spread rather than assigned: `exactOptionalPropertyTypes`
              // forbids passing an explicit `undefined` for an optional field.
              ...(controllerVersion === undefined ? {} : { controllerVersion }),
              ...(methodVersion === undefined ? {} : { methodVersion }),
              ...(versioningOptions === undefined ? {} : { versioningOptions }),
            },
            requestMethod,
          );

          for (const path of paths) {
            routes.push({
              controller: controller.name,
              handler: handlerName,
              method: RequestMethod[requestMethod],
              // The path as the router holds it, not as the factory built it.
              path: normalizePath(path),
              access,
              doc,
            });
          }
        }
      }
    }
  }

  return routes.sort(byMethodThenPath);
}

/** Sorted so the assertion's error message and the OpenAPI document are stable. */
export function byMethodThenPath(a: RouteDescriptor, b: RouteDescriptor): number {
  const left = `${a.method} ${a.path}`;
  const right = `${b.method} ${b.path}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function describeRoutes(app: INestApplication): RegisteredRoute[] {
  return describeRoutesFrom(
    app.get(DiscoveryService, { strict: false }),
    app.get(ApplicationConfig, { strict: false }),
    adapterPathNormaliser(app.getHttpAdapter()),
  );
}

/** Just enough of Express 5's router to read back what was registered on it. */
interface ExpressLayer {
  readonly route?: { readonly path: unknown; readonly methods: Record<string, boolean> };
}
interface ExpressInstance {
  readonly router?: { readonly stack?: readonly ExpressLayer[] };
}

/**
 * Every path on one registered layer, including the ones this module cannot
 * describe.
 *
 * Express accepts a `RegExp` — `express.get(/^\/rogue/, ...)` — and Nest never
 * emits one, so a non-string path can only come from registration that
 * bypassed the controller metadata entirely. That is precisely the case the
 * cross-check exists to catch, so dropping it would put the blind spot in the
 * last line of defence. Rendered as a string that no described route can ever
 * equal, it becomes a mismatch and refuses the boot.
 */
const registeredPathsOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  const unrecognised = (entry: unknown): string =>
    `<unrecognised path: ${entry instanceof RegExp ? entry.source : String(entry)}>`;
  if (Array.isArray(value))
    return value.map((entry: unknown) => (typeof entry === 'string' ? entry : unrecognised(entry)));
  return [unrecognised(value)];
};

/**
 * `"<METHOD> <path>"` for every route the HTTP adapter has actually registered,
 * read back off Express's own router.
 *
 * This is the control for the inventory above: the inventory is derived from
 * decorator metadata, and metadata is exactly the thing that is still there
 * when routing has stopped working. Comparing the two turns a wrong inventory
 * into a boot failure instead of an assertion that quietly checks nothing.
 *
 * Empty until `app.init()` runs — which is the point; see
 * `assertEveryRouteDeclaresAccess`.
 */
export function registeredRouterRoutes(app: INestApplication): string[] {
  // `getInstance()` is typed `any`; naming the two members read keeps that
  // `any` from spreading past this line.
  const instance = app.getHttpAdapter().getInstance() as unknown as ExpressInstance;
  const found: string[] = [];

  for (const layer of instance.router?.stack ?? []) {
    if (layer.route === undefined) continue;
    for (const [method, registered] of Object.entries(layer.route.methods)) {
      if (registered !== true) continue;
      const name = method === '_all' ? 'ALL' : method.toUpperCase();
      for (const path of registeredPathsOf(layer.route.path)) found.push(`${name} ${path}`);
    }
  }

  return found.sort();
}
