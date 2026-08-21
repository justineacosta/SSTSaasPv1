import type { ReactNode } from 'react';

/**
 * The public site's shell. Separate from `(auth)` and `(app)` because the
 * three groups differ in more than decoration: this one is indexable and
 * cacheable, the other two are neither (architecture/frontend.md §1–2).
 */
export default function MarketingLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
          <span className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
            Sentinel
          </span>
          <span className="text-[length:var(--text-micro)] leading-[var(--leading-micro)] tracking-[0.06em] text-[var(--color-text-subtle)] uppercase">
            Pre-release
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl grow px-4 py-10 sm:px-6 sm:py-14">{children}</main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)] sm:px-6">
          Sentinel performs authorised security testing against customer-owned assets only.
        </div>
      </footer>
    </div>
  );
}
