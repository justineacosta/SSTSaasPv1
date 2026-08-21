import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
// `VERSION_METADATA` and `VersionValue` are not on `@nestjs/common`'s barrel,
// only on these two — the same subpaths Nest's own router reads them from.
import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants.js';
import type { VersionValue } from '@nestjs/common/interfaces/index.js';
import { ApplicationConfig, DiscoveryService, MetadataScanner } from '@nestjs/core';
// Not part of `@nestjs/core`'s public index, and imported here on purpose.
// This class *is* the path assembly Nest's own router uses — global prefix,
// prefix exclusions, URI version segment, slash normalisation — so borrowing it
// means the inventory cannot disagree with the routes Nest registered. The
// alternative was a second implementation of the same 60 lines, which is
// exactly the drift architecture/backend.md §3 asks this assertion to prevent.
// If a Nest upgrade moves the file, the API fails to start rather than starting
// with a silently wrong inventory, and `assertEveryRouteDeclaresAccess` also
// compares its result against the live router on every boot.
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
 * Builds the route inventory from controller metadata.
 *
 * Takes the two collaborators rather than the application so that the
 * `/api/v1/openapi.json` handler — which has a `DiscoveryService` and an
 * `ApplicationConfig` injected but no `INestApplication` — can call it too.
 * Both are ordinary providers: Nest registers `ApplicationConfig` in every
 * module, and `DiscoveryService` comes from `DiscoveryModule`.
 */
export function describeRoutesFrom(
  discovery: DiscoveryService,
  config: ApplicationConfig,
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
              path,
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
      for (const path of asPaths(layer.route.path)) found.push(`${name} ${path}`);
    }
  }

  return found.sort();
}
