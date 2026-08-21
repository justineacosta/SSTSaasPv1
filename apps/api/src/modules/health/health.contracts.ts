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
 * Each schema is annotated with the type the handler actually returns, so the
 * documentation cannot drift from the implementation without failing to
 * compile — adding a field to `ReadinessReport` and forgetting it here stops
 * the build rather than quietly publishing a stale shape.
 */
const dependencyStatusSchema = z.enum(['ok', 'error']);

const overallStatusSchema = z.enum(['ok', 'degraded']);

export const livenessReportSchema = z.object({ status: z.literal('ok') });

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
