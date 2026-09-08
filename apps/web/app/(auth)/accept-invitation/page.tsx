import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AcceptInvitationScreen } from '../../../src/auth/AcceptInvitationScreen';
import { firstParam, type SearchParams } from '../../../src/auth/search-params';

export const metadata: Metadata = { title: 'Accept your invitation' };

/**
 * `/accept-invitation` — the third of `TOKEN_LINK_PATHS`
 * (`apps/api/src/modules/auth/emails/links.ts`), and the one that had no page
 * behind it until now. The path is fixed by the links already sitting in
 * people's inboxes; it is not a naming choice this file is free to make.
 *
 * Same reasoning as `/verify-email` and `/reset-password` for the token being
 * in the query string: it comes from a link in an email and there is nowhere
 * else for it to be. `links.ts` also records why it is `?token=` rather than a
 * path segment — only the query parameter is redacted by the logger.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const params = await searchParams;
  return <AcceptInvitationScreen token={firstParam(params['token'])} />;
}
