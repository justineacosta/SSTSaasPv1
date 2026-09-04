import type { ReactNode } from 'react';
import { MfaChallengeProvider } from '../../src/auth/MfaChallengeProvider';

/**
 * The authentication shell — a single centred column, no navigation, nothing
 * to click away to.
 *
 * Six routes render through it as of Task 16: `/register`, `/verify-email`,
 * `/login`, `/login/mfa`, `/forgot-password` and `/reset-password`. The rest of
 * `(auth)` — `/mfa/enroll` and `/invitations/[token]` — is still to come
 * (`ui-ux/page-map.md`). `(auth)` responses are dynamic and never cached
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
