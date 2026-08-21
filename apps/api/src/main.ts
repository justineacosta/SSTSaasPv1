import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@sentinel/config';
import { createLogger, type Logger } from '@sentinel/observability';
import { AppModule } from './app.module.js';
import { configureApp } from './app-setup.js';
import { assertEveryRouteDeclaresAccess } from './common/access-assertion.js';
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

  // Explicitly, and before the assertion: Nest registers no route until
  // `init()` runs. `listen()` runs it implicitly, so an assertion written
  // "immediately before listen" would inspect an empty router and pass without
  // checking anything. `listen()` below sees `isInitialized` and does not
  // repeat the work.
  await app.init();
  try {
    assertEveryRouteDeclaresAccess(app);
  } catch (error: unknown) {
    // `init()` has already opened the database pool, and an open pool keeps the
    // event loop alive: without this the process would set a failing exit code
    // and then sit there forever, which an orchestrator reads as "starting",
    // not as "crashed". Closing turns the refusal into an actual exit.
    try {
      await app.close();
    } catch {
      // Whatever went wrong shutting down, the refusal is the error the
      // operator needs — it names the undeclared routes. Swallowing the close
      // failure keeps it from replacing that message.
    }
    throw error;
  }

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
