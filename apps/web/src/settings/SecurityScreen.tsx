'use client';

import type { ReactNode } from 'react';
import { MfaPanel } from './MfaPanel';
import { PasswordPanel } from './PasswordPanel';
import { SessionsPanel } from './SessionsPanel';

/**
 * `/settings/security`.
 *
 * Three panels, in the order a user reaching this page most often wants them:
 * "where am I signed in", then the second factor, then the password.
 *
 * **No affordance here is permission-gated, and that is correct rather than an
 * omission.** Every route behind this screen is `@AuthenticatedOnly()` — the
 * five that existed already, and the three sessions routes this task added.
 * `security/authorization.md` §1's rule is why: a permission is always
 * (user, organisation, permission), and none of these operations has an
 * organisation. A user who belongs to no organisation at all can still change
 * their password and enrol a factor, and a `<Can>` around any of this would
 * hide it from exactly that user.
 */
export function SecurityScreen(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-text)]">
          Security
        </h1>
        <p className="text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-muted)]">
          Your sign-ins, your second factor and your password. These settings belong to your
          account, not to an organisation.
        </p>
      </div>

      <SessionsPanel />
      <MfaPanel />
      <PasswordPanel />
    </div>
  );
}
