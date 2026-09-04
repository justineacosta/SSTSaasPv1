import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ResetPasswordScreen } from '../../../src/auth/ResetPasswordScreen';
import { firstParam, type SearchParams } from '../../../src/auth/search-params';

export const metadata: Metadata = { title: 'Choose a new password' };

/** Same reasoning as `/verify-email`: the token comes from an emailed link. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const params = await searchParams;
  return <ResetPasswordScreen token={firstParam(params['token'])} />;
}
