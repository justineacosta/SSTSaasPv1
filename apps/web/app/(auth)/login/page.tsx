import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LoginScreen } from '../../../src/auth/LoginScreen';
import { firstParam, type SearchParams } from '../../../src/auth/search-params';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * The `next` parameter is read here and passed down **unvalidated on purpose**:
 * `LoginScreen` runs it through `safeRedirectPath` at the moment it navigates,
 * which is the one place that decision can be made once for both branches of
 * the `mfaRequired` union. Validating here as well would be a second place for
 * the rule to live and drift.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const params = await searchParams;
  return <LoginScreen redirectTo={firstParam(params['next'])} />;
}
