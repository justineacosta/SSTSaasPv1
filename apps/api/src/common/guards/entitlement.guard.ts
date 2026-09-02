import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * LAYER 6 OF `security/authorization.md` §2, AS A STUB THAT ALLOWS EVERYTHING.
 *
 * # A stub that denies nothing is honest; a missing layer is a hole
 *
 * That sentence is the Phase 2 plan's, and it is the whole argument for this
 * file. §2 numbers six layers and says every one of them can deny. Five are
 * built. The sixth — "does the plan allow this action, or is a quota
 * exhausted?" (402) — needs a subscription, a plan catalogue and Stripe as the
 * source of billing truth, none of which exist before Phase 10.
 *
 * The choice is therefore between a pipeline with five stages that *claims* six
 * and a pipeline with six stages, one of which is empty and says so. The second
 * is better for one reason: the position of the entitlement check relative to
 * the permission check is a decision, and it is made here, in the array in
 * `app.module.ts`, where it is visible. Made later, it would be made by whoever
 * happened to add a guard to that array in Phase 10, and 402-before-403 leaks
 * that a plan does not include a feature to a caller who was never allowed to
 * use it anyway.
 *
 * # What it must never become
 *
 * A `@RequireEntitlement()` decorator is deliberately **not** shipped alongside
 * this. `security/authorization.md` §5's example writes one, and a decorator
 * that routes could carry while nothing evaluated it is exactly the state
 * `@RequirePermission()` was in for five tasks — recorded in three documents,
 * misread at least once as enforcement. Phase 10 ships the decorator and the
 * evaluation together, in one change. Until then a route cannot declare an
 * entitlement, so no route can be wrong about one.
 *
 * # It is not `return true` with a comment
 *
 * `entitlement.guard.spec.ts` asserts that it admits a request that every other
 * layer would have admitted, and — the part that matters — that it is
 * *registered*, last, in the real `APP_GUARD` array. A stub nobody registered
 * is not a layer; it is a file. `app.module.spec.ts` pins the whole order.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  /**
   * Takes no parameter, deliberately. `CanActivate` supplies an
   * `ExecutionContext` and a method that declares fewer parameters still
   * satisfies the interface — so the signature itself says this stage reads
   * nothing about the request. Phase 10 adds the parameter back on the day it
   * has something to read from it.
   */
  canActivate(): boolean {
    // PHASE 10. Every request passes. See the docblock — this is the layer, not
    // a placeholder for one, and its position in `app.module.ts` is the
    // decision it exists to record.
    return true;
  }
}
