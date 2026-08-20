import { Module } from '@nestjs/common';
import type { ApiEnv } from '@sentinel/config';
import { createS3StorageAdapter, type StorageAdapter } from '@sentinel/storage';
import { ENV, STORAGE } from '../tokens.js';

@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ENV],
      useFactory: (env: ApiEnv): StorageAdapter =>
        createS3StorageAdapter({
          endpoint: env.STORAGE_ENDPOINT,
          region: env.STORAGE_REGION,
          accessKeyId: env.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
          forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
        }),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
