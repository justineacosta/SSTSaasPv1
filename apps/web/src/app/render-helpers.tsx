import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { z, ZodTypeAny } from 'zod';
import type { ApiClient, ApiRequestOptions } from '../api/client';
import { ApiClientProvider } from '../api/provider';

/**
 * Test-only helpers for the `(app)` shell and settings specs. Imported by
 * `*.spec.tsx` and by nothing the application ships, so the bundler never sees
 * it.
 *
 * It lives beside the components rather than in a `__tests__` directory for the
 * reason `src/auth/render-helpers.tsx` records: `vitest.workspace.ts`'s `ui`
 * project globs `apps/*` `/src/` `**` `/*.spec.tsx`, and
 * `scripts/check-vitest-projects.ts` fails a spec that matches no project.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/**
 * An {@link ApiClient} that answers from a function instead of the network, and
 * records what it was asked for.
 *
 * **The response still goes through the endpoint's contract schema**, which is
 * what makes these fixtures worth something: a spec that stubs a session list
 * carrying a `tokenHash` would have that field stripped by
 * `sessionSummarySchema`, and one that stubs a shape the API cannot send fails
 * here rather than passing over a fiction.
 */
export function stubClient(responder: (request: RecordedRequest) => unknown): {
  client: ApiClient;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const client: ApiClient = {
    request<TSchema extends ZodTypeAny>(
      options: ApiRequestOptions<TSchema>,
    ): Promise<z.output<TSchema>> {
      const record: RecordedRequest = {
        method: options.method,
        path: options.path,
        body: options.body,
      };
      requests.push(record);
      return Promise.resolve().then(
        () => options.responseSchema.parse(responder(record)) as z.output<TSchema>,
      );
    },
  };
  return { client, requests };
}

/** A client whose every call hangs, for asserting a loading state. */
export function pendingClient(): ApiClient {
  return {
    request: <TSchema extends ZodTypeAny>(): Promise<z.output<TSchema>> =>
      new Promise<never>(() => {
        /* never settles: the point is the pending state */
      }),
  };
}

/**
 * A `QueryClient` configured the way a spec needs and an application does not.
 *
 * `retry: false` so a rejected query fails once rather than three times with
 * backoff, and `gcTime: Infinity` so a query that has no observers is not
 * garbage-collected between an assertion and the next one — which would make
 * "the cache was cleared" pass for the wrong reason.
 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Renders inside the two providers the `(app)` tree supplies: TanStack Query
 * and the API client.
 *
 * The `QueryClient` is returned so a spec can inspect the cache directly, which
 * is how the organisation switcher's "clears the cache entirely" property is
 * asserted rather than inferred from a re-render.
 */
export function renderApp(
  ui: ReactNode,
  client: ApiClient,
  queryClient: QueryClient = testQueryClient(),
): RenderResult & { queryClient: QueryClient } {
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}
