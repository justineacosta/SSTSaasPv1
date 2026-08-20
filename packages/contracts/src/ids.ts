import { z } from 'zod';

/**
 * Client-facing ID validation. Clients must not parse IDs (api/conventions.md
 * §1); this schema exists so the API can reject a malformed one at the boundary
 * rather than passing it to the database.
 */
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function idSchema(prefix: string) {
  return z
    .string()
    .refine(
      (value) => value.startsWith(`${prefix}_`) && ID_BODY.test(value.slice(prefix.length + 1)),
      { message: `Expected an identifier beginning with "${prefix}_".` },
    );
}

export const organizationIdSchema = idSchema('org');
export const userIdSchema = idSchema('usr');
export const membershipIdSchema = idSchema('mbr');
export const invitationIdSchema = idSchema('inv');
