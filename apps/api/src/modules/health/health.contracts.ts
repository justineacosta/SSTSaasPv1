import { z } from 'zod';
import type { DetailedReport, ReadinessReport } from './health.service.js';

/**
 * The health endpoints' response bodies, as Zod schemas, for the published
 * OpenAPI document.
 *
 * These live beside the module rather than in `packages/contracts` because
 * nothing else consumes them: the contracts package is what the frontend and
 * the API share (backend.md §6), and no browser reads a readiness probe. An
 * operator's `curl` and a Kubernetes probe are the clients here.
 *
 * Two different bindings, and it is worth being exact about what each buys:
 *
 * - `livenessReportSchema` is the **source of truth**. `HealthController.live`
 *   returns the inferred `LivenessReport`, so the schema and the response
 *   cannot differ in either direction.
 * - `readinessReportSchema` and `detailedReportSchema` are annotated
 *   `z.ZodType<T>` against types `health.service.ts` already owns. Those two
 *   reports are assembled by the service from probe results rather than parsed
 *   from a schema, so type-first is the honest direction. The annotation is
 *   **one-directional**, though: adding a field to `ReadinessReport` and
 *   forgetting it here fails to compile, but adding a field *here* that the
 *   handler never returns stays assignable, and would publish a document
 *   promising a field the API does not send.
 *
 *   That second direction is closed at runtime instead, not by the compiler:
 *   `openapi/generate.integration.spec.ts` parses the live `/health/ready` and
 *   `/health/detailed` responses with these schemas, so a key a schema requires
 *   and the handler does not return is a failing test. It is the only check
 *   that catches it — the committed-document tests go green again the moment
 *   someone regenerates `openapi.json`, which is exactly what an author adding
 *   a field would do.
 */
const dependencyStatusSchema = z.enum(['ok', 'error']);

const overallStatusSchema = z.enum(['ok', 'degraded']);

export const livenessReportSchema = z.object({ status: z.literal('ok') });

/** Inferred, not declared alongside: the schema above is the only definition. */
export type LivenessReport = z.infer<typeof livenessReportSchema>;

export const readinessReportSchema: z.ZodType<ReadinessReport> = z.object({
  status: overallStatusSchema,
  dependencies: z.object({
    postgres: dependencyStatusSchema,
    redis: dependencyStatusSchema,
    storage: dependencyStatusSchema,
  }),
});

const probeSchema = z.object({
  status: dependencyStatusSchema,
  latencyMs: z.number().nonnegative(),
});

export const detailedReportSchema: z.ZodType<DetailedReport> = z.object({
  status: overallStatusSchema,
  checkedAt: z.string().datetime(),
  dependencies: z.object({
    postgres: probeSchema,
    redis: probeSchema,
    storage: probeSchema,
  }),
});
