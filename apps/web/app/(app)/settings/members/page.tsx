import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MembersScreen } from '../../../../src/settings/MembersScreen';

export const metadata: Metadata = { title: 'Members' };

/** A thin route file; see `../security/page.tsx` for why the screen lives in `src/`. */
export default function MembersSettingsPage(): ReactNode {
  return <MembersScreen />;
}
