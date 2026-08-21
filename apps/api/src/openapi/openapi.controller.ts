import { Controller, Get, Inject } from '@nestjs/common';
import { ApplicationConfig, DiscoveryService, HttpAdapterHost } from '@nestjs/core';
import { Public } from '../common/decorators/access.decorator.js';
import { ApiDoc } from '../common/decorators/openapi.decorator.js';
import { adapterPathNormaliser, describeRoutesFrom } from '../common/route-inventory.js';
import { buildOpenApiDocument, type OpenApiDocument } from './generate.js';

/**
 * Serves the OpenAPI description at `/api/v1/openapi.json`.
 *
 * architecture/backend.md §7 and the specification both write that path with no
 * environment qualifier, so it is served in every environment. That is a
 * deliberate call and not an oversight: the document describes the shape of a
 * public API surface, it names no host, no dependency and no internal
 * identifier, and a description that is only available where nobody looks at it
 * is a description that goes stale.
 *
 * Generated per process rather than read from the committed `openapi.json`, so
 * what is served is what this build actually routes. The committed file is
 * asserted equal to this in `generate.integration.spec.ts` and diffed in CI.
 */
@Controller('openapi.json')
export class OpenApiController {
  private cached: OpenApiDocument | undefined;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(ApplicationConfig) private readonly config: ApplicationConfig,
    // The document must describe the paths the router holds, which means
    // applying the adapter's own `normalizePath` exactly as the router does.
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /**
   * `@Public()` because this route is reached without authentication — and
   * because the boot assertion refuses to start otherwise, which makes this
   * controller its own smallest test.
   */
  @Public()
  @ApiDoc({
    summary: 'The OpenAPI description of this API.',
    responses: [{ status: 200, description: 'The OpenAPI 3.0 document.' }],
  })
  @Get()
  read(): OpenApiDocument {
    // Cached after the first request: the route inventory is a full walk of
    // every controller's metadata, and it cannot change while the process runs.
    return (this.cached ??= buildOpenApiDocument(
      describeRoutesFrom(
        this.discovery,
        this.config,
        adapterPathNormaliser(this.adapterHost.httpAdapter),
      ),
    ));
  }
}
