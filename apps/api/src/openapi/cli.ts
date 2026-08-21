import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { apiEnvSchema, loadEnv } from '@sentinel/config';
import { createLogger } from '@sentinel/observability';
import { AppModule } from '../app.module.js';
import { configureApp } from '../app-setup.js';
import { generateOpenApiDocument } from './generate.js';

/**
 * The committed artefact, resolved relative to this file so it lands in the
 * same place whether the script runs from `src` or from `dist`.
 */
export const OPENAPI_DOCUMENT_PATH = fileURLToPath(new URL('../../openapi.json', import.meta.url));

/**
 * Writes `apps/api/openapi.json`.
 *
 * `app.init()` is deliberately **not** called. Initialisation is what opens the
 * database pool and registers routes; generation needs neither, because the
 * document is built from controller metadata. Keeping it out means a
 * regeneration in CI or on a laptop does not require Postgres, Redis or MinIO
 * to be running — only a valid environment for the container to build.
 */
async function main(): Promise<void> {
  loadEnv(apiEnvSchema);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configureApp(app);

  const document = generateOpenApiDocument(app);
  // Two-space JSON with a trailing newline, which is what the test compares
  // against and what `.prettierignore` leaves alone.
  writeFileSync(OPENAPI_DOCUMENT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  createLogger({ service: 'api', level: 'info', pretty: false }).info(
    { path: OPENAPI_DOCUMENT_PATH, routes: Object.keys(document.paths).length },
    'OpenAPI document written',
  );
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  createLogger({ service: 'api', level: 'fatal', pretty: false }).fatal(
    { err: error },
    'OpenAPI generation failed',
  );
});
