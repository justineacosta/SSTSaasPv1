/**
 * Registers jest-dom's matcher types (`toBeInTheDocument`, `toHaveValue`,
 * `toHaveAttribute`, …) against Vitest's `expect` for this package.
 *
 * The matchers themselves are registered at runtime by
 * `packages/ui/src/test-setup.ts`, which the `ui` Vitest project loads as its
 * `setupFiles`. That file is inside packages/ui's tsconfig, so its type
 * augmentation reaches packages/ui's specs and stops there — this package's
 * `apps/web/src/*.spec.tsx` files got the matchers at runtime and none of the
 * types, which is `tsc` failing on 60 assertions that all pass when they run.
 *
 * A declaration file rather than a source file so nothing imports it by
 * accident, and one line rather than hand-written matcher declarations so it
 * cannot drift from the library's own.
 */
import '@testing-library/jest-dom/vitest';
