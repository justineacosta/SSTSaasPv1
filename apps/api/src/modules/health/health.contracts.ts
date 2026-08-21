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
 *   `z.ZodType<T>` against types `health.service.ts` already owns. That check is
 *   **one-directional**: adding a field to `ReadinessReport` and forgetting it
 *   here fails to compile, but adding a field *here* that the handler never
 *   returns stays assignable and would publish silently. Those two reports are
 *   assembled by the service from probe results rather than parsed from a
 *   schema, so type-first is the honest direction; the gap is real and is why
 *   the integration test asserts the served body's key shape separately.
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
