import { Alert, Card } from '@sentinel/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/**
 * The `(app)` group's placeholder.
 *
 * The task brief named this file `app/(app)/page.tsx`. That path resolves to
 * `/` — the same URL as `app/(marketing)/page.tsx` — and Next refuses to build
 * two pages that resolve to one path. `/dashboard` is the route
 * ui-ux/page-map.md already assigns to this group's overview, so the
 * placeholder lives there instead.
 *
 * There is deliberately no mock product UI on this page: no fake metric tiles,
 * no seeded findings table, no empty chart. A convincing screenshot of
 * something that does not exist is the specific illusion this codebase avoids.
 */
export default function AppPlaceholderPage(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-text)]">
        The product is not built yet.
      </h1>

      <Alert variant="warning">
        <span>
          Sentinel is in <strong className="font-medium">Phase 1 — Production foundation</strong>.
          There is no authentication, no organisation, no asset, no scan and no finding. This route
          exists so the <code>(app)</code> route group has a real boundary, not so it has something
          to show.
        </span>
      </Alert>

      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
            What exists today
          </h2>
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            A validated configuration loader, a redacting structured logger, shared contracts, an
            S3-compatible storage adapter, a Prisma schema with tenant-scoped access and row-level
            security, a NestJS API that answers health probes and nothing else, a design system of
            tokens and eight primitives — and this shell.
          </p>
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            Identity arrives in Phase 2, and it is what makes this group reachable at all. Until
            then this page is served to anyone who asks for it, because there is nothing here to
            protect.
          </p>
          <Link
            href="/"
            className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-accent)] underline underline-offset-2"
          >
            Back to the public site
          </Link>
        </div>
      </Card>
    </div>
  );
}
