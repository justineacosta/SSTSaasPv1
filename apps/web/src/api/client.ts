import type { z, ZodTypeAny } from 'zod';
import { ApiError, toApiError } from './errors';

/**
 * The cookie the API sets for double-submit CSRF, and the header it expects it
 * echoed in.
 *
 * Both are restated from `apps/api` rather than imported, because
 * `packages/contracts` does not export them and this task may not touch
 * `apps/api`. The authorities are `apps/api/src/modules/auth/cookies.ts:51`
 * (`__Host-csrf`, *not* `csrf` — the `__Host-` prefix is part of the name) and
 * `apps/api/src/common/guards/csrf.guard.ts:12` (`x-csrf-token`). If either
 * moves, this pair is the thing that has to move with it.
 *
 * The cookie deliberately has no `HttpOnly` (`cookies.ts:81`), which is the
 * entire mechanism: page script must be able to read it in order to echo it.
 */
export const CSRF_COOKIE_NAME = '__Host-csrf';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The methods that do NOT carry the CSRF header, written as the exempt list
 * exactly as `csrf.guard.ts:23` writes it. A method added later is then
 * guarded by default rather than unguarded by omission.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Reads one cookie out of a `document.cookie` string.
 *
 * Takes the string rather than reading `document` itself so it is testable
 * without a DOM and so the client has one injectable seam for it. Splits on the
 * FIRST `=` only: a cookie value may legitimately contain `=` (base64 padding),
 * and splitting on every one truncates it.
 */
export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    return trimmed.slice(separator + 1);
  }
  return null;
}

export interface ApiRequestOptions<TSchema extends ZodTypeAny> {
  readonly method: HttpMethod;
  /** Absolute path on the API, e.g. `/api/v1/auth/login`. */
  readonly path: string;
  /** The schema the response body must satisfy. Not optional, deliberately. */
  readonly responseSchema: TSchema;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  request<TSchema extends ZodTypeAny>(
    options: ApiRequestOptions<TSchema>,
  ): Promise<z.output<TSchema>>;
}

export interface ApiClientConfig {
  /**
   * The API origin. Arrives as a prop from a server component per ADR-0024 —
   * there is no `NEXT_PUBLIC_` variable and nothing here reads `process.env`.
   */
  readonly baseUrl: string;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to reading `document.cookie`. */
  readonly readCookieHeader?: () => string;
}

function defaultCookieHeader(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

/**
 * THE ONE PLACE THIS APPLICATION TALKS TO THE API.
 *
 * Four properties are the reason it is one module rather than a `fetch` per
 * form, and each of them is invisible from the screen when it is wrong:
 *
 * 1. **`credentials: 'include'` on every request.** The session is an ambient
 *    `__Host-` cookie on another origin (ADR-0017); without this the browser
 *    sends nothing and every authenticated call is anonymous.
 * 2. **The CSRF header on unsafe methods only.** Sending it on a `GET` would
 *    add a preflight to every read for no benefit; omitting it on a `POST` is
 *    a rejected request.
 * 3. **Every body is parsed by the endpoint's schema before it is returned.**
 *    A response the schema rejects is an {@link ApiError}, never a cast.
 * 4. **Every failure is an {@link ApiError} carrying `requestId`**, which
 *    `architecture/frontend.md` §6 requires in every error state.
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readCookieHeader = config.readCookieHeader ?? defaultCookieHeader;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  return {
    async request<TSchema extends ZodTypeAny>(
      options: ApiRequestOptions<TSchema>,
    ): Promise<z.output<TSchema>> {
      const headers = new Headers({ Accept: 'application/json' });
      const hasBody = options.body !== undefined;
      if (hasBody) headers.set('Content-Type', 'application/json');

      if (!isSafeMethod(options.method)) {
        const token = readCookie(readCookieHeader(), CSRF_COOKIE_NAME);
        // A missing token is NOT an error thrown here. The server is the
        // authority on whether the request is allowed, and it answers
        // CSRF_TOKEN_INVALID with a request ID a support engineer can trace.
        // Failing locally would produce an error with no request ID for the
        // one failure mode where the correlation matters most.
        if (token !== null) headers.set(CSRF_HEADER_NAME, token);
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${options.path}`, {
          method: options.method,
          headers,
          // The whole reason this module exists. See property 1 above.
          credentials: 'include',
          ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        throw new ApiError({
          kind: 'network',
          message: 'Could not reach the Sentinel API. Check your connection and try again.',
          cause,
        });
      }

      const text = await response.text();
      let body: unknown;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch (cause) {
          throw response.ok
            ? new ApiError({
                kind: 'malformed',
                status: response.status,
                message: 'The server returned a response this app could not read.',
                cause,
              })
            : toApiError(response.status, undefined);
        }
      }

      if (!response.ok) throw toApiError(response.status, body);

      const parsed = options.responseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError({
          kind: 'malformed',
          status: response.status,
          message: 'The server returned a response this app could not read.',
          cause: parsed.error,
        });
      }
      return parsed.data as z.output<TSchema>;
    },
  };
}
