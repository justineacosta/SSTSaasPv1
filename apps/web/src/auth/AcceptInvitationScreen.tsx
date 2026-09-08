'use client';

import type { MembershipResponse } from '@sentinel/contracts';
import { Alert, Skeleton } from '@sentinel/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { acceptInvitation } from '../api/invitation-endpoints';
import { useApiClient } from '../api/provider';
import { isSessionExpiry, loginHrefForDestination } from '../api/redirect';
import { AuthCard, FormErrorRegion } from './AuthCard';
import { toFormFailure, type FormFailure } from './server-errors';

/**
 * The route this screen is mounted at, written here because the screen has to
 * build a URL back to *itself* for the round trip through `/login`.
 *
 * It must stay equal to `TOKEN_LINK_PATHS.invitation` in
 * `apps/api/src/modules/auth/emails/links.ts`, which is the path already
 * printed in every invitation email that has been sent. The mail template is
 * the authority over any document, because its URLs are in people's inboxes and
 * cannot be changed retroactively.
 *
 * An older `/invitations/[token]` spelling was documented for a while and never
 * built. `ui-ux/page-map.md` was corrected in Task 17, before this screen
 * existed; `architecture/frontend.md` §2's route table and
 * `security/transport-and-headers.md` still carried it and are corrected in
 * Task 18, the change that ships this screen.
 */
export const ACCEPT_INVITATION_PATH = '/accept-invitation';

type AcceptanceStatus = 'no-token' | 'accepting' | 'accepted' | 'sign-in-required' | 'failed';

/**
 * `/accept-invitation`.
 *
 * The second screen in this group that submits **on load** rather than on a
 * click, and it is the same shape as `/verify-email` for the same reason: the
 * token arrives from a link in an email, there is nothing for the user to fill
 * in, and the only honest thing to do with it is redeem it and report what
 * happened.
 *
 * # The single-use token, and why the cleanup-abort is the wrong guard
 *
 * `reactStrictMode` is on (`next.config.ts`), so React mounts, unmounts and
 * remounts every component once in development and runs each effect twice. An
 * invitation token is single-use in exactly the way a verification token is:
 * the second call would consume nothing and answer the same 422
 * `TOKEN_INVALID`, and this screen would report a failure for an acceptance
 * that had already succeeded. The ref records the token already attempted, so
 * the second run is a no-op.
 *
 * **Aborting the request in the effect's cleanup — the usual answer — is wrong
 * here**, and this is not a style preference. The cleanup from the first mount
 * runs *before* the second effect runs, so it would cancel the only request
 * that was ever going to be sent; and worse, `POST /invitations/accept` is a
 * mutation, so an abort that lands after the server has committed the
 * membership leaves the token spent with nothing on screen to say so. A read
 * may be abandoned freely. This is not a read.
 *
 * # What "not signed in" looks like from here, and why that is the 401
 *
 * The route is `@AuthenticatedOnly()`. This screen does **not** resolve the
 * session first: `AuthenticationGuard` is registered before `CsrfGuard` in
 * `apps/api/src/app.module.ts`, so a signed-out visitor gets `UNAUTHENTICATED`
 * (or `SESSION_EXPIRED`) and never reaches the service — the token is not
 * consumed by the attempt. One request answers both "is there a session" and
 * "is this token good", instead of two requests answering one each.
 *
 * The invitee is then sent to `/login` with **this page's path and token** as
 * the destination, through `loginHrefForDestination` — the mechanism Task 16
 * built and left with no caller. `AppShell` cannot do this job: it redirects
 * with `usePathname()`, which drops the query string, and the token is the
 * query string.
 *
 * **The invitee with no account is offered `/register`, and is deliberately not
 * carried back here afterwards.** The address on the invitation must match the
 * address they sign in as, so registering under a different one produces the
 * same unusable 422; the footer says which address to use. Threading `next`
 * through registration would be a lie about what happens next —
 * `POST /auth/register` answers `VERIFICATION_REQUIRED` and issues **no
 * session**, so a redirect back to this screen would return a signed-out user
 * to a page whose only move is to send them to `/login` again. The invitation
 * email is the durable way back, and it is already in their inbox.
 *
 * # What the success state may claim
 *
 * `membershipResponseSchema` is the whole of what the API returns, and it
 * carries `organizationId`, `roleKey`, `status` and the user — **no
 * organisation name**. So this screen names the role, shows the identifier it
 * actually has, and does not invent a display name it was not given. And it
 * says out loud that the active organisation has not changed, because it has
 * not: switching is `POST /auth/switch-org`, which is what the organisation
 * switcher in the shell calls.
 */
export function AcceptInvitationScreen({ token }: { token: string | null }): ReactNode {
  const client = useApiClient();
  const router = useRouter();
  const [status, setStatus] = useState<AcceptanceStatus>(
    token === null || token === '' ? 'no-token' : 'accepting',
  );
  const [membership, setMembership] = useState<MembershipResponse | null>(null);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const attemptedToken = useRef<string | null>(null);

  // Built with `URLSearchParams` rather than by interpolation, so no value of
  // `token` can add a second parameter to the URL this screen asks to be
  // returned to. `loginHrefForDestination` then runs the whole thing through
  // `safeRedirectPath` on the way *in*, which is the open-redirect check.
  const returnHere = `${ACCEPT_INVITATION_PATH}?${new URLSearchParams({ token: token ?? '' }).toString()}`;
  const loginHref = loginHrefForDestination(returnHere);

  useEffect(() => {
    if (token === null || token === '') return;
    if (attemptedToken.current === token) return;
    attemptedToken.current = token;

    void (async () => {
      try {
        setMembership(await acceptInvitation(client, { token }));
        setStatus('accepted');
      } catch (error) {
        if (isSessionExpiry(error)) {
          setStatus('sign-in-required');
          return;
        }
        setFailure(toFormFailure(error));
        setStatus('failed');
      }
    })();
  }, [client, token]);

  // In an effect rather than during render, for the reason `AppShell` records:
  // a router navigation is a side effect, and calling it while rendering
  // produces React's "cannot update a component while rendering" warning, which
  // the e2e suite fails on as a console error.
  useEffect(() => {
    if (status === 'sign-in-required') router.replace(loginHref);
  }, [status, loginHref, router]);

  if (status === 'accepting') {
    return (
      <AuthCard title="Accepting your invitation" lead="This takes a moment.">
        {/* A skeleton matching the final layout rather than a spinner, and no
            layout shift when the answer arrives. frontend.md §6. */}
        <div aria-busy="true" aria-live="polite" className="flex flex-col gap-3">
          <span className="sr-only">Accepting your invitation.</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </AuthCard>
    );
  }

  if (status === 'sign-in-required') {
    return (
      <AuthCard
        title="Sign in to accept this invitation"
        lead="Invitations are tied to the address they were sent to, so we need to know who you are before we can add you."
        footer={
          <span>
            No account yet? <Link href="/register">Create one</Link> with the address the invitation
            was sent to, then open the link in the email again.
          </span>
        }
      >
        <p className="text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text)]">
          {/* The same href the effect above navigates to, on screen as well, so
              an invitee whose navigation has not happened yet is not left on a
              card with nothing to click. */}
          <Link href={loginHref}>Sign in</Link> and we will bring you straight back here.
        </p>
      </AuthCard>
    );
  }

  // `status` alone decides this branch, and the membership only decides how
  // much detail it can show. The review's L1: the condition used to be
  // `status === 'accepted' && membership !== null`, so an acceptance that
  // somehow arrived without a body fell through to "We could not accept that
  // invitation" — telling the invitee their acceptance failed when it had
  // succeeded, which is precisely the failure the StrictMode ref guard exists
  // to prevent. Unreachable today, because both setters batch into one render;
  // reachable the moment someone reorders them.
  if (status === 'accepted') {
    return (
      <AuthCard
        title="Invitation accepted"
        footer={<Link href="/dashboard">Go to the dashboard</Link>}
      >
        <Alert variant="success">
          <div className="flex flex-col gap-1">
            <span>
              You have joined
              {membership === null ? null : (
                <>
                  {' '}
                  with the role <strong>{membership.roleKey}</strong>
                </>
              )}
              . Your active organisation has not changed — use the organisation switcher at the top
              of the app to start working in the one you just joined.
            </span>
            {/* The API returns a membership, and a membership carries an
                organisation identifier and not an organisation name. Rendering
                the identifier is honest; inventing a name, or spending a second
                request on a terminal confirmation to look one up, is not. */}
            {membership === null ? null : (
              <span className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
                Organisation <code>{membership.organizationId}</code>
              </span>
            )}
          </div>
        </Alert>
      </AuthCard>
    );
  }

  if (status === 'no-token') {
    return (
      <AuthCard title="This link is incomplete" footer={<Link href="/login">Back to sign in</Link>}>
        <Alert variant="warning">
          <span>
            The invitation link did not carry a token. Some mail clients shorten long links — copy
            the whole URL from the email, or ask whoever invited you to send a new invitation.
          </span>
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="We could not accept that invitation"
      // NOTHING HERE MAY GUESS AT WHY. The API answers one 422 `TOKEN_INVALID`
      // with one message for a token that is unknown, out of date, withdrawn,
      // spent, superseded, or addressed to another person — deliberately, so
      // the endpoint is not an oracle for whether a given token exists. Copy
      // that named a cause would rebuild that oracle in the browser. The
      // server's own message is rendered, and nothing is added to it.
      // The review's M3. The old lead was "Ask whoever invited you to send a new
      // invitation." — advice that is actively wrong for the two likeliest
      // causes in practice, both of which are "you are signed in as the wrong
      // account". This wording covers every one of the six states equally and
      // therefore names none of them, so it is not the oracle the comment above
      // forbids: it is the same guidance the signed-out branch already gives.
      lead="Invitations are single-use, they expire, and they only work for the address they were sent to. Check you are signed in as the invited address, or ask whoever invited you to send a new invitation."
      footer={<Link href="/login">Back to sign in</Link>}
    >
      {failure === null ? null : <FormErrorRegion failure={failure} />}
    </AuthCard>
  );
}
