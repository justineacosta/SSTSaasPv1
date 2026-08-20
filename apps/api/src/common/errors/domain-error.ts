import type { ErrorCode } from '@sentinel/contracts';

/**
 * The base class for every error the domain raises.
 *
 * Domain code never throws a bare Error: a bare Error carries no code, so the
 * filter can only map it to INTERNAL_ERROR, and the client learns nothing it
 * can act on. A refusal that does not say how to succeed generates a support
 * ticket. See api/errors.md §4.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
