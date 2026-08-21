import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { fontVariables } from './fonts';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: {
    default: 'Sentinel',
    template: '%s · Sentinel',
  },
  description:
    'Security testing, penetration-test management, and vulnerability management for assets you own and have proved you own.',
  // Keeps a pre-release shell out of search results. Removed deliberately,
  // by the change that decides this origin is ready to be indexed.
  robots: { index: false, follow: false },
};

/**
 * Every HTML route in this app is server-rendered per request.
 *
 * This is a real cost and it is paid deliberately. `architecture/frontend.md`
 * §2 wants marketing Static with ISR, and that is the right long-term answer
 * for SEO and speed. It is incompatible today with the nonce-based CSP in
 * `security/transport-and-headers.md` §3, and the incompatibility is
 * structural rather than a configuration mistake: Next injects the CSP nonce
 * into its own inline bootstrap scripts by reading the CSP header off the
 * *request*, and a page prerendered at build time was never rendered for a
 * request. Verified rather than assumed — with this line removed, `/` built as
 * `○ (Static)` and `.next/server/app/index.html` contained nine inline
 * `<script>` tags and zero `nonce=` attributes. `script-src` carries
 * `'strict-dynamic'`, so under an enforcing policy those un-nonced inline
 * scripts — and every chunk they would have loaded — are blocked, and the page
 * ships as dead HTML.
 *
 * Given a choice between a strict CSP and a static marketing page, Phase 1
 * takes the CSP: this is a security product, and `'unsafe-inline'` is the
 * only other way to make prerendering work. Revisit when marketing content
 * actually exists and there is something for ISR to cache — the shape of the
 * fix is a CDN-level policy for the prerendered public routes, not a weaker
 * policy for everything.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  // Tells the browser both schemes are supported, so form controls,
  // scrollbars and the address bar match the tokens rather than defaulting to
  // light chrome around a dark page.
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={fontVariables}>
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
