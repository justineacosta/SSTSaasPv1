import type { ReactNode } from 'react';
import { MfaChallengeProvider } from '../../src/auth/MfaChallengeProvider';

/**
 * The authentication shell — a single centred column, no navigation, nothing
 * to click away to.
 *
 * Seven routes render through it: `/register`, `/verify-email`, `/login`,
 * `/login/mfa`, `/forgot-password` and `/reset-password` from Task 16, and
 * `/accept-invitation`. The rest of `(auth)` — `/mfa/enroll` — is still to come
 * (`ui-ux/page-map.md`).
 *
 * The invitation screen is at `/accept-invitation`, and not at the older
 * `/invitations/[token]` spelling that was documented for a while and never
 * built: the path is fixed by
 * `TOKEN_LINK_PATHS.invitation` in
 * `apps/api/src/modules/auth/emails/links.ts`, which is what every invitation
 * email already sent points at, and by `links.ts`'s own rule that the secret
 * travels as `?token=` rather than as a path segment. `(auth)` responses are
 * dynamic and never cached
 * (`architecture/frontend.md` §2); that is a property of the group, set once in
 * the root layout's `force-dynamic`, not of each page below it.
 *
 * `MfaChallengeProvider` is here rather than on a page because it is the thing
 * `/login` and `/login/mfa` share. The App Router keeps a shared layout mounted
 * across a client-side navigation, which is what lets the pending MFA
 * credential cross that step **in memory** instead of in the URL.
 */
export default function AuthLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <MfaChallengeProvider>{children}</MfaChallengeProvider>
      </div>
    </div>
  );
}
