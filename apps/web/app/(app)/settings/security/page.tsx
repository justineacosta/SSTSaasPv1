import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SecurityScreen } from '../../../../src/settings/SecurityScreen';

export const metadata: Metadata = { title: 'Security' };

/**
 * A thin route file. The screen lives under `apps/web/src/` because
 * `vitest.workspace.ts`'s `ui` project include glob is `apps/*\/src/**\/*.spec.tsx`
 * and a spec placed under `app/` would match zero projects, failing
 * `pnpm check:specs`. Same reasoning as Task 16's six auth routes.
 */
export default function SecuritySettingsPage(): ReactNode {
  return <SecurityScreen />;
}
