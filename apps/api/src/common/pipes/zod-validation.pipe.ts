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

/**
 * One issue becomes one field error — except an `unrecognized_keys` issue,
 * which becomes one per key.
 *
 * Zod reports every unknown key of one object in a SINGLE issue: the issue's
 * `path` is the PARENT object's path (empty at the root) and the keys live in
 * `issue.keys`. Running that through `formatPath` alone produces a field error
 * with an empty path and a message naming several keys at once — a 400 that
 * says "there is an unknown field somewhere in your body", which a client
 * cannot attach to an input and a developer cannot act on.
 *
 * So the issue is expanded: one entry per key, each with the full dotted path
 * of the offending key (`nested.extar`) and a message naming only that key.
 */
function toFieldErrors(issue: ZodIssue): FieldError[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      // `path` IS REDACTED HERE AND NOWHERE ELSE IN THIS FILE, deliberately.
      // For every other issue code the path is built from the schema's own key
      // names, which are ours. Here the final segment is a key the CALLER
      // invented, so it is untrusted text on the same footing as `message` —
      // and a caller who pasted a credentialed URL into a JSON key would
      // otherwise get it mirrored back into a response that may be logged or
      // screenshotted. errors.md §5.
      path: redactSecretsInText(formatPath([...issue.path, key])),
      code: issue.code,
      message: redactSecretsInText(`Unrecognized field "${key}".`),
    }));
  }
  return [toFieldError(issue)];
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

    const { issues } = result.error;
    const fields = issues.flatMap(toFieldErrors);

    // EVERY issue, not ANY issue, and the difference matters.
    //
    // A body that both misspells a field and breaks a real validation rule is
    // a validation failure. Reporting it as UNKNOWN_FIELD would tell the
    // client the only problem was the spelling — it would fix the spelling and
    // fail again, for a reason the first response never mentioned. Never hide
    // a validation failure behind a different code.
    //
    // The unrecognised keys stay in `details.fields` either way, because the
    // code is the weaker signal and `fields` is what a form binds to.
    //
    // api/conventions.md §8 note: a client branching on VALIDATION_ERROR will
    // start seeing UNKNOWN_FIELD for a pure unknown-field failure. That is a
    // contract change, which is why it lands now — before any endpoint ships —
    // rather than once there is a client to break.
    const everyIssueIsUnknownField = issues.every((issue) => issue.code === 'unrecognized_keys');

    throw new DomainError(
      everyIssueIsUnknownField ? ERROR_CODES.UNKNOWN_FIELD : ERROR_CODES.VALIDATION_ERROR,
      everyIssueIsUnknownField
        ? 'The request contains unknown fields.'
        : 'The request contains invalid fields.',
      400,
      { fields },
    );
  }
}
