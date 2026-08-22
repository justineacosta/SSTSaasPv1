import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@sentinel/contracts';

/**
 * The single metadata key under which every route declares how it is reached.
 *
 * One key, not two, and one shape, not a boolean plus a string: a route either
 * declares itself public or names the permission it requires, and "neither" is
 * a third state that a boot-time assertion refuses to start on. Two independent
 * keys would make "public AND permission-guarded" and "no declaration at all"
 * indistinguishable from each other at the point where it matters — see
 * architecture/backend.md §3, "a route without an explicit access declaration
 * fails a startup assertion".
 */
export const ACCESS_METADATA_KEY = 'sentinel:access';

export type AccessDeclaration =
  { readonly kind: 'public' } | { readonly kind: 'permission'; readonly permission: Permission };

/**
 * Declares a route reachable without authentication.
 *
 * Deliberately explicit rather than a default: the boot assertion that Task 11
 * adds treats an undeclared route as a defect, so forgetting the decorator
 * crashes startup instead of quietly shipping an open endpoint.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_METADATA_KEY, { kind: 'public' });

/**
 * Declares the permission a caller must hold. The permission string is typed
 * against `PERMISSIONS` in `@sentinel/contracts`, so a typo is a compile error
 * rather than a guard that silently never matches.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_METADATA_KEY, { kind: 'permission', permission });
