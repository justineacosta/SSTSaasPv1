import type { INestApplication } from '@nestjs/common';
import { errorEnvelopeSchema } from '@sentinel/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AccessDeclaration } from '../common/decorators/access.decorator.js';
import type { DocumentedSchema } from '../common/decorators/openapi.decorator.js';
import { describeRoutes, type RegisteredRoute } from '../common/route-inventory.js';

/**
 * OpenAPI 3.0, not 3.1, because `zod-to-json-schema`'s `openApi3` target emits
 * the 3.0 dialect (`nullable`, no `$schema`). Claiming 3.1 while emitting 3.0
 * shapes would be a document that lies about itself.
 */
const OPENAPI_VERSION = '3.0.3';

const ERROR_ENVELOPE = 'ErrorEnvelope';

/**
 * The version of the *contract*, which is the thing `/api/v1` names — not the
 * build. A document whose `info.version` moved with every release would produce
 * a CI diff on every release, which is how a diff gate gets ignored.
 */
const CONTRACT_VERSION = '1';

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Record<string, { readonly schema: Record<string, unknown> }>;
}

/**
 * A described request body. Always `required`, because the only bodies this API
 * documents are ones its Zod schema refuses to parse when absent — an optional
 * body would be a claim that the handler accepts an empty request, which none
 * of them do.
 */
export interface OpenApiRequestBody {
  readonly description?: string;
  readonly required: true;
  readonly content: Record<string, { readonly schema: Record<string, unknown> }>;
}

/**
 * One templated path segment, as OpenAPI describes it.
 *
 * `required: true` always: a path parameter is part of the path, and an
 * optional one is a different path. `schema` is a bare string because every
 * identifier this API puts in a path is one — narrowing it to the contract's
 * `organizationIdSchema` would need the generator to know which parameter
 * belongs to which resource, which is a mapping nothing maintains.
 */
export interface OpenApiPathParameter {
  readonly name: string;
  readonly in: 'path';
  readonly required: true;
  readonly description: string;
  readonly schema: { readonly type: 'string' };
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiPathParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Record<string, OpenApiResponse>;
  /**
   * The route's access declaration, published as a vendor extension.
   *
   * There is no `securitySchemes` entry to point at yet — authentication is
   * Phase 2 — and inventing one would describe a control that does not exist.
   * Publishing the declaration instead makes an authorization change visible in
   * the committed document's diff, which is the review step backend.md §7 is
   * asking for.
   */
  readonly 'x-sentinel-access'?: AccessDeclaration;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

const toJsonSchema = (schema: DocumentedSchema): Record<string, unknown> =>
  zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });

function responsesFor(route: RegisteredRoute): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {};

  const declared = [...(route.doc?.responses ?? [])].sort((a, b) => a.status - b.status);
  for (const response of declared) {
    responses[String(response.status)] = {
      description: response.description,
      ...(response.schema === undefined
        ? {}
        : { content: { 'application/json': { schema: toJsonSchema(response.schema) } } }),
    };
  }

  // Every route, unconditionally: the global exception filter guarantees that
  // any error this API returns is the shared envelope (backend.md §5), so it is
  // part of every route's contract whether or not the route remembered to say
  // so. This is also the link to the Zod contracts §7 asks for — the schema
  // below is `packages/contracts`' own, not a copy of it.
  responses['default'] = {
    description: 'Error. Every error response uses the shared envelope.',
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${ERROR_ENVELOPE}` } } },
  };

  return responses;
}

/**
 * EXPRESS PATH SYNTAX IS NOT OPENAPI PATH SYNTAX, AND UNTIL TASK 13 NOTHING
 * NOTICED.
 *
 * The route inventory holds paths exactly as Express registered them, which is
 * what makes `assertEveryRouteDeclaresAccess` able to compare the two — so
 * `:id` is correct there and must stay. OpenAPI templates the same segment as
 * `{id}`, and a document publishing `/api/v1/organizations/:id` describes a
 * literal path with a colon in it: a generated client would request
 * `/organizations/%3Aid` and every validator would report an undeclared
 * parameter.
 *
 * Phase 1 shipped only health probes and Phase 2's first eighteen routes take
 * no path parameter, so the generator was never asked to render one and the gap
 * was invisible rather than accepted. The three `:id` routes of Task 13 are the
 * first, which is why this is here and not earlier.
 */
const OPENAPI_PATH_PARAMETER = /:([A-Za-z0-9_]+)/g;

export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(OPENAPI_PATH_PARAMETER, '{$1}');
}

export function pathParametersOf(expressPath: string): OpenApiPathParameter[] {
  return [...expressPath.matchAll(OPENAPI_PATH_PARAMETER)].map((match) => ({
    // `match[1]` is the capture group, which the regular expression guarantees
    // for every match. The `?? ''` is unreachable and exists because
    // `noUncheckedIndexedAccess` types it as possibly undefined; an empty name
    // would fail validation loudly rather than silently naming nothing.
    name: match[1] ?? '',
    in: 'path' as const,
    required: true as const,
    description: 'Path parameter.',
    schema: { type: 'string' as const },
  }));
}

function operationFor(route: RegisteredRoute): OpenApiOperation {
  const parameters = pathParametersOf(route.path);
  return {
    operationId: `${route.controller}_${route.handler}`,
    tags: [route.controller.replace(/Controller$/, '')],
    ...(route.doc === undefined ? {} : { summary: route.doc.summary }),
    ...(route.doc?.description === undefined ? {} : { description: route.doc.description }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(route.doc?.requestBody === undefined
      ? {}
      : {
          requestBody: {
            ...(route.doc.requestBody.description === undefined
              ? {}
              : { description: route.doc.requestBody.description }),
            required: true as const,
            content: {
              'application/json': { schema: toJsonSchema(route.doc.requestBody.schema) },
            },
          },
        }),
    responses: responsesFor(route),
    ...(route.access === undefined ? {} : { 'x-sentinel-access': route.access }),
  };
}

/**
 * Refuses a document in which two operations share an `operationId`.
 *
 * One handler can legitimately produce several routes — `@Get(['a', 'b'])`, or
 * `@Version(['1', '2'])` — and every one of them would be named
 * `Controller_handler`. Duplicate `operationId`s make the document invalid, and
 * the tools that consume it report that badly or not at all: a client generator
 * silently emits one method and drops the other. Failing here means the
 * regeneration script and the committed-document test both refuse before it can
 * be merged.
 */
function assertUniqueOperationIds(operations: readonly OpenApiOperation[]): void {
  const seen = new Map<string, number>();
  for (const operation of operations) {
    seen.set(operation.operationId, (seen.get(operation.operationId) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length === 0) return;

  throw new Error(
    [
      `OpenAPI generation refused: ${duplicates.length} duplicate operationId(s).`,
      '',
      ...duplicates.map((id) => `  ${id}`),
      '',
      'An operationId must be unique. One handler serving several paths or',
      'several versions produces one operation per path, all named after that',
      'handler — give each its own handler.',
    ].join('\n'),
  );
}

/**
 * Builds the document from an already-collected route inventory.
 *
 * Split from `generateOpenApiDocument` so the shape of the document can be
 * asserted against hand-built routes — including routes this codebase cannot
 * have, such as one carrying a permission — without standing up an application.
 */
export function buildOpenApiDocument(routes: readonly RegisteredRoute[]): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};

  // Sorted by path, then method, so the committed artefact changes only when
  // the API does. An unstable key order would make every regeneration a diff.
  const sorted = [...routes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.method < b.method ? -1 : a.method > b.method ? 1 : 0;
  });

  const operations: OpenApiOperation[] = [];
  for (const route of sorted) {
    const operation = operationFor(route);
    operations.push(operation);
    // The OpenAPI rendering of the path, not the Express one. See
    // `toOpenApiPath`.
    const item = (paths[toOpenApiPath(route.path)] ??= {});
    item[route.method.toLowerCase()] = operation;
  }
  assertUniqueOperationIds(operations);

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Sentinel API',
      version: CONTRACT_VERSION,
      description:
        'Multi-tenant security testing, penetration-test management, and vulnerability management.',
    },
    paths,
    components: { schemas: { [ERROR_ENVELOPE]: toJsonSchema(errorEnvelopeSchema) } },
  };
}

/**
 * The published description of this API, derived from the routes the
 * application actually has.
 *
 * The path list comes from the router's own metadata rather than from a table
 * maintained alongside it, so the document cannot describe a route that was
 * deleted or miss one that was added — which is the only way "diffed in CI"
 * (backend.md §7) means anything.
 */
export function generateOpenApiDocument(app: INestApplication): OpenApiDocument {
  return buildOpenApiDocument(describeRoutes(app));
}
