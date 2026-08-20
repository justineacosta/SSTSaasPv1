import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly organizationId?: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` with an ambient request context. Every log line emitted inside —
 * including from awaited async work and from queue producers — carries the
 * correlation IDs without the caller threading them through by hand.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
