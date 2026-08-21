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

export interface OpenApiOperation {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary?: string;
  readonly description?: string;
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

function operationFor(route: RegisteredRoute): OpenApiOperation {
  return {
    operationId: `${route.controller}_${route.handler}`,
    tags: [route.controller.replace(/Controller$/, '')],
    ...(route.doc === undefined ? {} : { summary: route.doc.summary }),
    ...(route.doc?.description === undefined ? {} : { description: route.doc.description }),
    responses: responsesFor(route),
    ...(route.access === undefined ? {} : { 'x-sentinel-access': route.access }),
  };
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

  for (const route of sorted) {
    const item = (paths[route.path] ??= {});
    item[route.method.toLowerCase()] = operationFor(route);
  }

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
