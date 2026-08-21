import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OpenApiController } from './openapi.controller.js';

/**
 * `DiscoveryModule` is imported for the controller's own injection of
 * `DiscoveryService`; `AppModule` imports it separately for the boot-time
 * access assertion, which resolves the same provider off the application.
 */
@Module({ imports: [DiscoveryModule], controllers: [OpenApiController] })
export class OpenApiModule {}
