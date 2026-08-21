import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from 'next/font/google';

/**
 * next/font self-hosts these at build time, which is what keeps
 * `font-src 'self'` true rather than aspirational. A Google Fonts <link> would
 * silently require a CSP exception, and a CSP with exceptions nobody
 * remembers is how a strict policy erodes.
 */

/** Body: all prose, form labels, descriptions, buttons. 400/500. */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-sans',
  fallback: ['ui-sans-serif', 'system-ui'],
});

/**
 * Display: page titles, table headers, metric labels, nav sections. 600.
 *
 * The condensed cut earns its place functionally rather than stylistically —
 * a findings table has eight or nine meaningful columns, and condensed headers
 * buy horizontal room that system-ui does not. design-system.md §2.
 */
const condensed = IBM_Plex_Sans_Condensed({
  subsets: ['latin'],
  weight: ['600'],
  display: 'swap',
  variable: '--font-condensed',
  fallback: ['ui-sans-serif', 'system-ui'],
});

/** Data: evidence, HTTP captures, CVSS vectors, fingerprints, IDs, counts. */
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo'],
});

/**
 * The three variable classes, applied together to <html>. Every face is
 * declared once, at the root, so no subtree can be rendered without the family
 * it references existing.
 */
export const fontVariables = `${sans.variable} ${condensed.variable} ${mono.variable}`;
