import { Injectable, type PipeTransform } from '@nestjs/common';
import type { TypeOf, ZodIssue, ZodTypeAny } from 'zod';
import { ERROR_CODES, type FieldError } from '@sentinel/contracts';
import { redactSecretsInText } from '@sentinel/observability';
import { DomainError } from '../errors/domain-error.js';

/**
 * Renders a Zod issue path as the dotted/bracketed notation the client sees in
 * its own request body: `targets[0]`, `scope.rules[2].value`. A root-level
 * failure — the whole body was the wrong type — has an empty path, because
 * there is no input to attach it to and inventing a name like `(root)` would
 * have a client hunting for a field that does not exist. errors.md §2.
 */
function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((accumulator, segment) => {
    if (typeof segment === 'number') return `${accumulator}[${String(segment)}]`;
    return accumulator === '' ? segment : `${accumulator}.${segment}`;
  }, '');
}

function toFieldError(issue: ZodIssue): FieldError {
  return {
    path: formatPath(issue.path),
    code: issue.code,
    // Zod's message text quotes the received value for some issue codes
    // (`invalid_enum_value`, `invalid_literal`). That value is the caller's own
    // input, so echoing it is not a cross-tenant leak — but a caller who pasted
    // a credentialed URL into the wrong field would get it mirrored back into a
    // response that may be logged or screenshotted. Substring redaction costs
    // nothing and closes that. errors.md §5.
    message: redactSecretsInText(issue.message),
  };
}

/**
 * Validates one HTTP input against a `packages/contracts` schema.
 *
 * The schema is the source of truth and the same one the frontend uses, so
 * client and server cannot drift (architecture/backend.md §6). The pipe returns
 * the *parsed* value, not the input, so coercions and defaults declared in the
 * contract actually reach the handler.
 *
 * Phase 1 has no consumer — health takes no input. It exists now so Phase 2's
 * first endpoint inherits a validated boundary rather than inventing its own,
 * and its unit test drives it directly.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): TypeOf<TSchema> {
    const result = this.schema.safeParse(value);
    // `safeParse` on a `ZodTypeAny` widens `data` to `any`; the schema's own
    // inferred output type is the honest one.
    if (result.success) return result.data as TypeOf<TSchema>;

    const fields = result.error.issues.map(toFieldError);
    throw new DomainError(
      ERROR_CODES.VALIDATION_ERROR,
      'The request contains invalid fields.',
      400,
      { fields },
    );
  }
}
