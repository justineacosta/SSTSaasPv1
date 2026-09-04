import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MfaScreen } from '../../../../src/auth/MfaScreen';

export const metadata: Metadata = { title: 'Two-factor authentication' };

/**
 * No props, and that is the point. The pending credential this screen needs
 * reaches it through the `(auth)` layout's in-memory context, never through the
 * URL — a query string lands in history, in `Referer`, and in every access log
 * on the path.
 */
export default function MfaPage(): ReactNode {
  return <MfaScreen />;
}
