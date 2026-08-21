import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app-setup.js';

// The live compose stack is the system under test. `.env` is the same file the
// developer's own `pnpm dev` reads, so drift between the two is caught here
// rather than in production.
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });
// environments.md §1: the test environment logs nothing unless a test asks for
// it, and enforces CSP rather than merely reporting it — a policy that is only
// ever report-only where it is asserted is a policy no test has seen block
// anything.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

/**
 * The real application — every module, the real `configureApp` — built the way
 * `bootstrap()` builds it, for the integration lane.
 *
 * Shared rather than copied into each spec: a second copy is a second
 * bootstrap, and the whole point of `configureApp` is that the application a
 * test asserts against is the application the process runs.
 *
 * `controllers` adds throwaway controllers alongside the real ones, for
 * behaviour that needs a route the product does not have (a handler that
 * throws, say).
 */
export async function buildApp(controllers: readonly Type[] = []): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [...controllers],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}
