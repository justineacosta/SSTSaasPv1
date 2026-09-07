import { Alert, Card } from '@sentinel/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/**
 * The `(app)` group's overview.
 *
 * The task brief named this file `app/(app)/page.tsx`. That path resolves to
 * `/` — the same URL as `app/(marketing)/page.tsx` — and Next refuses to build
 * two pages that resolve to one path. `/dashboard` is the route
 * ui-ux/page-map.md already assigns to this group's overview, so the page lives
 * there instead.
 *
 * **There is still deliberately no mock product UI here: no fake metric tiles,
 * no seeded findings table, no empty chart.** A convincing screenshot of
 * something that does not exist is the specific illusion this codebase avoids,
 * and it is why the copy below is a list of what exists rather than a
 * dashboard.
 *
 * Task 17 changed the copy only as far as became true. Phase 2 built identity,
 * so the sentences claiming "no authentication and no organisation" and "served
 * to anyone who asks for it" were false and are gone; the sentence that there
 * is no asset, scan or finding is still true and stays.
 */
export default function AppOverviewPage(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-text)]">
        There is no product here yet.
      </h1>

      <Alert variant="warning">
        <span>
          Sentinel is in <strong className="font-medium">Phase 2 — Identity</strong>. Accounts,
          sessions, organisations, roles and invitations are built. There is no asset, no scope, no
          scan and no finding, so there is nothing for an overview to show.
        </span>
      </Alert>

      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
            What you can do today
          </h2>
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            Manage the devices signed in to your account, turn on two-factor authentication and
            change your password on{' '}
            <Link
              href="/settings/security"
              className="text-[var(--color-accent)] underline underline-offset-2"
            >
              Security
            </Link>
            . Managing who belongs to this organisation — inviting, removing and changing roles, for
            those who hold organization.manage_members — is on{' '}
            <Link
              href="/settings/members"
              className="text-[var(--color-accent)] underline underline-offset-2"
            >
              Members
            </Link>
            .
          </p>
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            Registering an asset, proving you own it, defining scope and running a scan are later
            phases. This page will show real numbers when there are real numbers to show, and not
            before.
          </p>
        </div>
      </Card>
    </div>
  );
}
