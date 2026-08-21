import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { ERROR_CODES } from '@sentinel/contracts';
import { Public } from '../../common/decorators/access.decorator.js';
import { ApiDoc } from '../../common/decorators/openapi.decorator.js';
import { RateLimitExempt } from '../../common/decorators/rate-limit.decorator.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  detailedReportSchema,
  type LivenessReport,
  livenessReportSchema,
  readinessReportSchema,
} from './health.contracts.js';
import { type DetailedReport, HealthService, type ReadinessReport } from './health.service.js';

/**
 * `VERSION_NEUTRAL`, and excluded from the global `api` prefix in `main.ts`, so
 * these answer at `/health/live`, `/health/ready` and `/health/detailed` —
 * the paths operations/monitoring.md §5 and architecture/backend.md §8 both
 * write. A probe URL that moves with an API version is a probe URL that breaks
 * a deployment on the day the version changes.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /**
   * Liveness checks the process and NOTHING else.
   *
   * A liveness probe that checks Postgres restarts every application instance
   * simultaneously during a database blip, turning a hiccup into a full
   * outage. monitoring.md §5.
   *
   * `@RateLimitExempt()` is part of that guarantee, not an optimisation: the
   * rate-limit guard reaches Redis, so a limited liveness route would depend on
   * a backing service. The exemption is asserted by a test that watches for
   * Redis traffic while probing, because the property previously held only
   * because no scope of the default class happened to resolve.
   */
  @Public()
  @RateLimitExempt()
  @ApiDoc({
    summary: 'Liveness probe.',
    description: 'Reports that the process is running. Touches no dependency.',
    responses: [
      { status: 200, description: 'The process is alive.', schema: livenessReportSchema },
    ],
  })
  @Get('live')
  live(): LivenessReport {
    return { status: 'ok' };
  }

  /**
   * Readiness gates traffic and deploys. A degraded result is a 503 carrying the
   * per-dependency verdict in the shared error envelope, so the same body shape
   * serves an operator reading it by hand and a client parsing it.
   */
  @Public()
  @ApiDoc({
    summary: 'Readiness probe.',
    description: 'Reports whether every backing dependency is reachable.',
    responses: [
      {
        status: 200,
        description: 'Every dependency is reachable.',
        schema: readinessReportSchema,
      },
      {
        status: 503,
        description:
          'At least one dependency is unavailable. The envelope names which, and nothing else.',
      },
    ],
  })
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.health.checkDependencies();
    if (report.status !== 'ok') {
      throw new DomainError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'One or more dependencies are unavailable.',
        503,
        { dependencies: report.dependencies },
      );
    }
    return report;
  }

  /**
   * Operator detail — currently readiness plus per-probe timings, and nothing
   * more.
   *
   * monitoring.md §5 specifies this endpoint as **authenticated**, carrying
   * queue depth, worker heartbeats, and migration state. None of those exist in
   * Phase 1, and neither does authentication. Shipping the operator payload
   * behind a decorator that no guard yet reads would be an open infrastructure
   * map with a comment claiming otherwise, so the endpoint deliberately ships
   * with the narrowest possible superset of `/health/ready`: which dependency,
   * how long it took. The queue, worker, and migration fields arrive in the
   * same change as the guard that protects them, not before.
   */
  @Public()
  @ApiDoc({
    summary: 'Operator detail.',
    description: 'Readiness plus a per-dependency probe latency.',
    responses: [
      { status: 200, description: 'Readiness with timings.', schema: detailedReportSchema },
    ],
  })
  @Get('detailed')
  detailed(): Promise<DetailedReport> {
    return this.health.detailed();
  }
}
