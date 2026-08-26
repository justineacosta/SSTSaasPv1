import type { z } from 'zod';
import type { ZodInvalidStringIssue, ZodIssue } from 'zod';

/**
 * Thrown at boot when configuration is missing or malformed.
 *
 * The message names the offending variables and NEVER their values — an env
 * validation error is one of the easiest places to accidentally log a
 * connection string containing a password.
 */
export class EnvValidationError extends Error {
  readonly variables: string[];

  constructor(variables: string[], detail: string) {
    super(`Invalid environment configuration.\n${detail}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

function describeStringValidation(validation: ZodInvalidStringIssue['validation']): string {
  if (typeof validation === 'string') return validation;
  if ('startsWith' in validation) return `start with "${validation.startsWith}"`;
  if ('endsWith' in validation) return `end with "${validation.endsWith}"`;
  if ('includes' in validation) return `include "${validation.includes}"`;
  return 'the required format';
}

/**
 * Describes a single Zod issue using only fields whose shape is fixed and
 * authored by us — the schema's own rule parameters, expected shapes, and
 * issue codes — and NEVER `issue.message` or a field that can carry the
 * value that failed validation (`invalid_enum_value` and `invalid_literal`
 * both carry a `received` field holding the raw input; it is deliberately
 * never read here).
 *
 * This is a safety-by-construction choice, not an audit of today's Zod
 * error-map text: auditing which issue codes happen to produce safe message
 * strings is a check that silently expires on the next Zod upgrade. Owning
 * the strings does not.
 */
function describeIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      // `expected`/`received` are type-category tags ("string", "undefined",
      // "nan", ...), never the value itself.
      return `expected ${issue.expected}, received ${issue.received}`;
    case 'invalid_literal':
      return `must be exactly ${JSON.stringify(issue.expected)}`;
    case 'invalid_enum_value':
      return `must be one of: ${issue.options.map(String).join(', ')}`;
    case 'too_small':
      return `must be at least ${String(issue.minimum)}${issue.type === 'string' ? ' character(s)' : ''}`;
    case 'too_big':
      return `must be at most ${String(issue.maximum)}${issue.type === 'string' ? ' character(s)' : ''}`;
    case 'invalid_string':
      return `must ${describeStringValidation(issue.validation)}`;
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.multipleOf)}`;
    case 'not_finite':
      return 'must be finite';
    case 'invalid_date':
      return 'must be a valid date';
    case 'unrecognized_keys':
      return `unrecognized key(s): ${issue.keys.join(', ')}`;
    case 'invalid_union':
      return 'did not match any allowed shape';
    case 'invalid_union_discriminator':
      return `must be one of: ${issue.options.map(String).join(', ')}`;
    case 'invalid_intersection_types':
      return 'could not be merged';
    case 'custom': {
      // `params` is authored in this repository's own schemas, exactly like the
      // `startsWith` above — so reading it keeps the rule this function is
      // built on (never `issue.message`, only our own rule parameters) while
      // letting a cross-field or scheme rule say why it failed instead of
      // printing "failed validation (custom)", which says nothing.
      const rule: unknown = issue.params?.['rule'];
      return typeof rule === 'string' ? rule : `failed validation (${issue.code})`;
    }
    case 'invalid_arguments':
    case 'invalid_return_type':
      return `failed validation (${issue.code})`;
    default:
      return 'failed validation';
  }
}

/**
 * Parses and validates configuration. Call once, at boot. A service must never
 * run half-configured and fail confusingly later.
 */
export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data as z.infer<TSchema>;

  const issues = result.error.issues;
  const variables = [...new Set(issues.map((issue) => String(issue.path[0] ?? '(root)')))].sort();
  // Report the variable name and the rule it broke — never the value it held.
  const detail = issues
    .map((issue) => `  ${String(issue.path[0] ?? '(root)')}: ${describeIssue(issue)}`)
    .join('\n');

  throw new EnvValidationError(variables, detail);
}
