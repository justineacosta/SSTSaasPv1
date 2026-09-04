import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RegisterScreen } from '../../../src/auth/RegisterScreen';

export const metadata: Metadata = { title: 'Create your account' };

/**
 * A server component that renders one client screen and nothing else. The route
 * files in this group carry metadata and read the query string; every piece of
 * behaviour lives in `src/auth/`, where a `.spec.tsx` can reach it.
 *
 * That split is not stylistic. The `ui` Vitest project's include glob only
 * covers `src` directories inside an app or package (`vitest.workspace.ts`), so
 * a spec placed beside a file under `app/` would match no project at all —
 * `pnpm test` passes `--passWithNoTests` and would print green while running
 * none of it. `pnpm check:specs` fails on exactly that, deliberately.
 */
export default function RegisterPage(): ReactNode {
  return <RegisterScreen />;
}
