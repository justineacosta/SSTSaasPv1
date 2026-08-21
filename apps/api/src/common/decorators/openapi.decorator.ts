import { SetMetadata } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Any Zod schema. Deliberately not Zod's own `ZodTypeAny`, which is
 * `ZodType<any, ...>` — coding-standards.md §1 bans `any` without a written
 * justification, and there is none here: nothing in this codebase reads a
 * documented schema's inferred type, so `unknown` costs nothing.
 */
export type DocumentedSchema = ZodType<unknown, ZodTypeDef, unknown>;

/**
 * The metadata key under which a route describes itself for the published
 * OpenAPI document.
 *
 * architecture/backend.md §7 says the document is generated "from the Zod
 * contracts **and decorators**", and this is the decorator half. It carries the
 * Zod schema itself rather than a hand-written JSON Schema, so the description
 * a client reads and the schema the server would validate against are the same
 * object — §6's "the schema is the source of truth, never a hand-written
 * interface alongside it" applied to documentation.
 *
 * `@nestjs/swagger` is deliberately not used: it does not read Zod, so every
 * route would have to declare its shape twice — once for validation and once
 * for documentation — which is the drift this key exists to prevent.
 */
export const OPENAPI_METADATA_KEY = 'sentinel:openapi';

/**
 * One documented response. `schema` is optional because a status code is worth
 * documenting on its own: `/health/ready` returning 503 is part of its contract
 * even though its body is the shared error envelope every route already
 * documents.
 */
export interface ApiResponseDeclaration {
  readonly status: number;
  readonly description: string;
  readonly schema?: DocumentedSchema;
}

export interface ApiDocDeclaration {
  readonly summary: string;
  readonly description?: string;
  readonly responses: readonly ApiResponseDeclaration[];
}

/**
 * Describes a route in the generated OpenAPI document.
 *
 * Method-only, and deliberately optional: unlike `@Public()` /
 * `@RequirePermission()`, a missing declaration here is a thinner document, not
 * a security hole, so it is not worth a boot failure. A route without it still
 * appears in the document — the path list comes from the router, not from this
 * decorator — it simply carries no summary and no response bodies.
 */
export const ApiDoc = (declaration: ApiDocDeclaration): MethodDecorator =>
  SetMetadata<string, ApiDocDeclaration>(OPENAPI_METADATA_KEY, declaration);
