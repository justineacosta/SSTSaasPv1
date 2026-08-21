import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RegisteredRoute } from '../common/route-inventory.js';
import { buildOpenApiDocument } from './generate.js';

const route = (over: Partial<RegisteredRoute>): RegisteredRoute => ({
  controller: 'HealthController',
  handler: 'live',
  method: 'GET',
  path: '/health/live',
  access: { kind: 'public' },
  doc: undefined,
  ...over,
});

describe('buildOpenApiDocument', () => {
  it('describes the document as the dialect it actually emits', () => {
    const document = buildOpenApiDocument([route({})]);
    expect(document.openapi).toBe('3.0.3');
    expect(document.info.title).toBe('Sentinel API');
    expect(document.info.version).toBe('1');
  });

  it('gives every route an operation under its own path and method', () => {
    const document = buildOpenApiDocument([
      route({}),
      route({ handler: 'ready', path: '/health/ready' }),
      route({
        controller: 'ScansController',
        handler: 'create',
        method: 'POST',
        path: '/api/v1/scans',
      }),
    ]);

    expect(Object.keys(document.paths)).toEqual(['/api/v1/scans', '/health/live', '/health/ready']);
    expect(document.paths['/api/v1/scans']?.['post']?.operationId).toBe('ScansController_create');
    expect(document.paths['/health/live']?.['get']?.tags).toEqual(['Health']);
  });

  it('keeps two methods on one path side by side', () => {
    const document = buildOpenApiDocument([
      route({
        controller: 'ScansController',
        handler: 'create',
        method: 'POST',
        path: '/api/v1/scans',
      }),
      route({
        controller: 'ScansController',
        handler: 'list',
        method: 'GET',
        path: '/api/v1/scans',
      }),
    ]);
    expect(Object.keys(document.paths['/api/v1/scans'] ?? {})).toEqual(['get', 'post']);
  });

  it('orders paths and methods independently of the order routes arrive in', () => {
    // The committed artefact is diffed in CI. An ordering that depended on
    // module import order would produce a diff on every regeneration, and a
    // diff gate that always fires is a diff gate nobody reads.
    const forwards = buildOpenApiDocument([
      route({ path: '/a' }),
      route({ path: '/b' }),
      route({ handler: 'create', method: 'POST', path: '/a' }),
    ]);
    const backwards = buildOpenApiDocument([
      route({ handler: 'create', method: 'POST', path: '/a' }),
      route({ path: '/b' }),
      route({ path: '/a' }),
    ]);
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });

  it('documents the shared error envelope once and points every route at it', () => {
    const document = buildOpenApiDocument([route({}), route({ path: '/health/ready' })]);

    const envelope = document.components.schemas['ErrorEnvelope'];
    expect(envelope).toMatchObject({
      type: 'object',
      properties: { error: { type: 'object', required: ['code', 'message', 'requestId'] } },
    });

    for (const path of Object.keys(document.paths)) {
      expect(document.paths[path]?.['get']?.responses['default']?.content).toEqual({
        'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
      });
    }
  });

  it('converts a declared Zod response schema into the response body', () => {
    const document = buildOpenApiDocument([
      route({
        doc: {
          summary: 'Liveness probe.',
          description: 'Touches no dependency.',
          responses: [
            {
              status: 200,
              description: 'Alive.',
              schema: z.object({ status: z.literal('ok') }),
            },
          ],
        },
      }),
    ]);

    const operation = document.paths['/health/live']?.['get'];
    expect(operation?.summary).toBe('Liveness probe.');
    expect(operation?.description).toBe('Touches no dependency.');
    expect(operation?.responses['200']).toEqual({
      description: 'Alive.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('documents a status code declared without a body', () => {
    const document = buildOpenApiDocument([
      route({
        doc: {
          summary: 'Readiness probe.',
          responses: [{ status: 503, description: 'A dependency is unavailable.' }],
        },
      }),
    ]);
    expect(document.paths['/health/live']?.['get']?.responses['503']).toEqual({
      description: 'A dependency is unavailable.',
    });
  });

  it('publishes the access declaration so an authorization change shows up in the diff', () => {
    const document = buildOpenApiDocument([
      route({ access: { kind: 'permission', permission: 'finding.read' } }),
    ]);
    expect(document.paths['/health/live']?.['get']?.['x-sentinel-access']).toEqual({
      kind: 'permission',
      permission: 'finding.read',
    });
  });

  it('still documents a route that declared nothing, rather than dropping it', () => {
    // The path list comes from the router, not from `@ApiDoc`. A route that
    // forgot to describe itself must still appear, or the document would
    // silently under-report the API's surface.
    const document = buildOpenApiDocument([route({ doc: undefined })]);
    const operation = document.paths['/health/live']?.['get'];
    expect(operation?.summary).toBeUndefined();
    expect(Object.keys(operation?.responses ?? {})).toEqual(['default']);
  });
});
