import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { firstParam, type SearchParams } from '../../../src/auth/search-params';
import { VerifyEmailScreen } from '../../../src/auth/VerifyEmailScreen';

export const metadata: Metadata = { title: 'Verify your email' };

/**
 * The token is in the query string because it arrives from a link in an email
 * and there is nowhere else for it to be. That is the existing design of
 * `POST /auth/verify-email`, not something introduced here.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const params = await searchParams;
  return <VerifyEmailScreen token={firstParam(params['token'])} />;
}
