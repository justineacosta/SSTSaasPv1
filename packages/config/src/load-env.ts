import type { z } from 'zod';

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
    .map((issue) => `  ${String(issue.path[0] ?? '(root)')}: ${issue.message}`)
    .join('\n');

  throw new EnvValidationError(variables, detail);
}
