/**
 * Tailwind v4 is a PostCSS plugin, and this file is how Next finds it. The
 * whole configuration surface lives in CSS (`app/globals.css` and
 * `packages/ui/src/tokens.css`) — v4 has no `tailwind.config.js`.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
