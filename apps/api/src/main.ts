import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { AppModule } from './app.module.js';
import { configureApp } from './app-setup.js';
import { ENV, LOGGER } from './infrastructure/tokens.js';

async function bootstrap(): Promise<void> {
  // First, before anything binds a port or opens a pool: a missing or malformed
  // variable must crash startup naming the variable, not surface later as a
  // confusing runtime failure. environments.md §3.
  loadEnv(apiEnvSchema);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);

  const env = app.get<ApiEnv>(ENV);
  const logger = app.get<Logger>(LOGGER);
  await app.listen(env.API_PORT);
  logger.info({ port: env.API_PORT, appEnv: env.APP_ENV }, 'API listening');
}

// Deliberately not top-level `await`: keeping the entry point free of it is
// what leaves the CommonJS fallback described in the Phase 1 plan available
// without a rewrite, and it costs nothing here.
void bootstrap().catch((error: unknown) => {
  process.exitCode = 1;
  // The configured logger may not exist yet — this is the path a bad
  // environment takes. A minimal one is still the redacting logger, which is
  // what matters: a boot failure is exactly where a connection string would
  // otherwise reach stderr in the clear.
  createLogger({ service: 'api', level: 'fatal', pretty: false }).fatal(
    { err: error },
    'API failed to start',
  );
});
