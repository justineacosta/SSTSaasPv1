import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { StorageModule } from '../../infrastructure/storage/storage.module.js';
import { ENV, EVIDENCE_BUCKET } from '../../infrastructure/tokens.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [PrismaModule, RedisModule, StorageModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: EVIDENCE_BUCKET,
      inject: [ENV],
      useFactory: (env: ApiEnv): string => env.STORAGE_BUCKET_EVIDENCE,
    },
  ],
})
export class HealthModule {}
