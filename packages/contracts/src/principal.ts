import type { Permission } from './permissions.js';

/**
 * WHO IS MAKING THIS REQUEST — and nothing about which tenant or what they may
 * do. security/authentication.md §1: authentication establishes identity;
 * tenant resolution and authorization are separate, later stages. Keeping them
 * separate is what makes multi-organisation consultants and organisation
 * switching work without a re-login.
 *
 * THESE ARE PLAIN TYPES, NOT ZOD SCHEMAS, AND THAT IS DELIBERATE. Every other
 * shape in this package is a wire contract, inferred from a schema because it
 * is parsed from an external input. A `Principal` is the opposite: it is
 * constructed server-side by the authentication guard out of trusted database
 * state and is never parsed from a request body. Publishing a
 * `principalSchema` here would be an affordance for
 * `principalSchema.parse(req.body)` — minting a principal out of
 * attacker-controlled JSON, which is the single worst mistake available in
 * this phase. If a later task needs to send a principal over the wire, it
 * defines a separate response schema for that; `sessionResponseSchema` in
 * `auth.ts` is the one this phase needs, and its shape is deliberately not
 * this one.
 */
export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * DEFINED, AND NOT IMPLEMENTED IN PHASE 2.
 *
 * api/authentication.md §1 has both credential types resolve to the same
 * `Principal` so every downstream guard is written once rather than grown a
 * second branch later. Declaring the arm now is what makes that true. API key
 * issuance, acceptance and storage are all out of scope for Phase 2 — nothing
 * constructs one of these yet.
 *
 * `permissions` is the key's own subset, never "the user's powers over the
 * wire": an API key is always scoped to exactly one organisation, which is why
 * `organizationId` sits on the principal here and nowhere on the user arm.
 */
export interface ApiKeyPrincipal {
  readonly kind: 'apiKey';
  readonly keyId: string;
  readonly organizationId: string;
  readonly permissions: readonly Permission[];
}

export type Principal = UserPrincipal | ApiKeyPrincipal;

/**
 * The exact wording thrown for an API-key principal, exported so a caller can
 * assert on it without duplicating the string.
 */
export const API_KEY_PRINCIPAL_NOT_IMPLEMENTED =
  'API key principals are not implemented in Phase 2. This code path must not treat one as authorised.';

export function isUserPrincipal(principal: Principal): principal is UserPrincipal {
  return principal.kind === 'user';
}

/**
 * Narrows to the user arm, or throws.
 *
 * Phase 2 code that can only handle a session-authenticated user calls this
 * rather than assuming. It THROWS rather than returning `undefined` or falling
 * through, because the failure mode of the alternative is an unimplemented
 * API-key principal being silently treated as authorised — a type that exists
 * before its enforcement does is only safe if reaching it is loud.
 *
 * The `never` assignment in the final branch is a compile-time exhaustiveness
 * check: adding a third arm to `Principal` without handling it here fails the
 * build instead of falling into a runtime default.
 */
export function assertUserPrincipal(principal: Principal): UserPrincipal {
  switch (principal.kind) {
    case 'user':
      return principal;
    case 'apiKey':
      throw new Error(API_KEY_PRINCIPAL_NOT_IMPLEMENTED);
    default: {
      const unhandled: never = principal;
      throw new Error(`Unhandled principal kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
