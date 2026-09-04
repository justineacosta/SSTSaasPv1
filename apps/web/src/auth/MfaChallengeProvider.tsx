'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface MfaChallenge {
  /**
   * The credential `POST /auth/login` returns on the `mfaRequired: true` arm.
   *
   * **This value never goes in a URL.** A query string lands in browser
   * history, in the `Referer` header of every subsequent request, and in the
   * access log of every server and proxy on the path. A pending credential in
   * any of those places is a credential an attacker can replay to finish
   * somebody else's sign-in.
   */
  readonly pendingToken: string;
  /**
   * The already-validated destination to return to after the challenge. A path,
   * never a URL — `safeRedirectPath` has run on it before it gets here.
   */
  readonly redirectTo: string;
}

interface MfaChallengeStore {
  readonly challenge: MfaChallenge | null;
  readonly startChallenge: (challenge: MfaChallenge) => void;
  readonly clearChallenge: () => void;
}

const MfaChallengeContext = createContext<MfaChallengeStore | null>(null);

/**
 * Carries the pending MFA credential from `/login` to `/login/mfa` **in
 * memory**, and nowhere else.
 *
 * This provider is rendered by the `(auth)` layout, which both routes share.
 * The App Router keeps a shared layout mounted across a client-side navigation,
 * so `router.push('/login/mfa')` preserves this state while a full page load
 * discards it — which is the behaviour we want from a credential store. There
 * is no `sessionStorage` and no cookie here on purpose: both survive a reload,
 * and a pending credential that survives a reload is one that outlives the
 * attempt that created it.
 *
 * The cost is stated rather than hidden: **opening `/login/mfa` directly, or
 * reloading it, loses the challenge.** That screen therefore has a real empty
 * state that sends the user back to `/login`, and it is tested.
 */
export function MfaChallengeProvider({ children }: { children: ReactNode }): ReactNode {
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);

  const store = useMemo<MfaChallengeStore>(
    () => ({
      challenge,
      startChallenge: (next: MfaChallenge) => {
        setChallenge(next);
      },
      clearChallenge: () => {
        setChallenge(null);
      },
    }),
    [challenge],
  );

  return <MfaChallengeContext.Provider value={store}>{children}</MfaChallengeContext.Provider>;
}

/**
 * Throws outside the provider rather than returning an empty challenge. A
 * silent default here would look exactly like "the challenge expired", which is
 * a real state, and the two would be indistinguishable in a bug report.
 */
export function useMfaChallenge(): MfaChallengeStore {
  const store = useContext(MfaChallengeContext);
  if (store === null)
    throw new Error('useMfaChallenge must be used inside <MfaChallengeProvider>.');
  return store;
}
