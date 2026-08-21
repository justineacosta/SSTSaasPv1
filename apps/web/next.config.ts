import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `next dev` otherwise writes `apps/web/AGENTS.md` and an `apps/web/CLAUDE.md`
  // pointing at it, on every run. Observed once and then disabled: this
  // repository's documentation rule puts authored guidance in `.claude/` and
  // keeps the root CLAUDE.md short, and a second, generated CLAUDE.md that
  // nobody wrote and nobody reviews is exactly the kind of unowned
  // documentation that rule exists to prevent.
  //
  // The content Next generates is not worthless, though, and the point it
  // leads with is worth repeating here: Next 16 differs from what a model is
  // likely to have been trained on — `middleware.ts` is now `proxy.ts`, and
  // the Turbopack builder is the default. The reference it points to is real
  // and readable: `node_modules/next/dist/docs/`.
  agentRules: false,

  // The API strips `X-Powered-By` in its own middleware; this is the same
  // decision on this origin. Version-advertising headers are free
  // reconnaissance.
  poweredByHeader: false,

  // security/transport-and-headers.md §6 — "Source maps are not published for
  // production application bundles." This is Next's default; it is written out
  // because a default that a security document depends on should be visible in
  // the config rather than inferred from its absence.
  productionBrowserSourceMaps: false,

  // Deliberately no `serverExternalPackages` for pino. One was added on the
  // assumption that its worker-thread pretty transport would not survive
  // bundling, then removed after testing the assumption: with pino bundled,
  // `/api/csp-report` logged correctly against `next start` in both JSON and
  // pretty modes. See apps/web/src/logger.ts.

  // A note on import specifiers, because this app breaks the workspace's
  // convention and the reason should not have to be rediscovered:
  //
  // Every other package here is `nodenext` ESM and writes `./foo.js` for a
  // `foo.ts` file. Inside apps/web, imports are **extensionless** instead
  // (`./foo`), because Next 16 builds with Turbopack and Turbopack does not
  // apply the `.js` -> `.ts` substitution. Tried and rejected:
  // `experimental.extensionAlias`, which Next accepts and prints as an active
  // experiment, but which is read only by next/dist/build/webpack-config.js —
  // with it set, `next build` still failed with "Module not found: Can't
  // resolve './src/env.js'". apps/web's tsconfig uses
  // `moduleResolution: "bundler"` for the same reason, which is what makes
  // extensionless specifiers type-check.
  //
  // The one exception is `src/security-headers.spec.ts`, which Vitest runs
  // through Vite — Vite does perform the substitution.
};

export default nextConfig;
