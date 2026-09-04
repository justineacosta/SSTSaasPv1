import { render, type RenderResult } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import type { z, ZodTypeAny } from 'zod';
import type { ApiClient, ApiRequestOptions } from '../api/client';
import { ApiClientProvider } from '../api/provider';
import { MfaChallengeProvider, useMfaChallenge, type MfaChallenge } from './MfaChallengeProvider';

/**
 * Test-only helpers for the `(auth)` screen specs. Imported by `*.spec.tsx`
 * and by nothing the application ships — it is not reachable from any route, so
 * the bundler never sees it.
 *
 * It lives beside the components rather than in a `__tests__` directory because
 * `vitest.workspace.ts`'s `ui` project globs `apps/*` `/src/` `**` `/*.spec.tsx`
 * and `scripts/check-vitest-projects.ts` fails a spec that matches no project.
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
 * **The response still goes through the endpoint's contract schema.** That is
 * deliberate and it is what makes these fixtures worth something: a spec that
 * stubs `{ mfaRequired: true }` without a `pendingToken` fails here rather than
 * quietly testing a shape the API cannot send.
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
      // `Promise.resolve().then` rather than an async function so a responder
      // that throws rejects the promise instead of throwing synchronously out
      // of `request`, which is what a real network client would do.
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
 * Renders a screen inside the two providers the `(auth)` layout supplies — the
 * API client and the in-memory MFA challenge store — so a spec exercises the
 * same tree the route does.
 */
export function renderAuth(ui: ReactNode, client: ApiClient): RenderResult {
  return render(authTree(ui, client));
}

/**
 * The wrapped tree on its own, for a spec that needs to call `rerender`.
 * Testing Library's `rerender` replaces the root element outright, so passing
 * the bare screen would drop the providers and the screen would throw.
 */
export function authTree(ui: ReactNode, client: ApiClient): ReactNode {
  return (
    <ApiClientProvider client={client}>
      <MfaChallengeProvider>{ui}</MfaChallengeProvider>
    </ApiClientProvider>
  );
}

/**
 * Seeds the in-memory challenge before rendering its consumer, so `/login/mfa`
 * can be exercised without driving `/login` first.
 *
 * The seeding happens in an effect rather than as a provider prop because the
 * provider deliberately has no way to be initialised from outside — the only
 * thing that may start a challenge is a successful `POST /auth/login`, and a
 * seedable provider would be a second way in that production code could reach
 * for later.
 */
function ChallengeSeeder({
  challenge,
  children,
}: {
  challenge: MfaChallenge;
  children: ReactNode;
}): ReactNode {
  const { challenge: current, startChallenge } = useMfaChallenge();
  useEffect(() => {
    startChallenge(challenge);
    // `startChallenge` changes identity with the stored challenge, so listing
    // it here would re-run this effect after it succeeds. The seed is a
    // one-shot by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return current === null ? null : children;
}

export function renderAuthWithChallenge(
  ui: ReactNode,
  client: ApiClient,
  challenge: MfaChallenge,
): RenderResult {
  return render(
    <ApiClientProvider client={client}>
      <MfaChallengeProvider>
        <ChallengeSeeder challenge={challenge}>{ui}</ChallengeSeeder>
      </MfaChallengeProvider>
    </ApiClientProvider>,
  );
}
