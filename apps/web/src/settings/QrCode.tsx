'use client';

import { create as createQrCode } from 'qrcode';
import { useMemo, type ReactNode } from 'react';

/**
 * THE ENROLMENT QR CODE, DRAWN AS SVG RECTANGLES BY REACT.
 *
 * # Why a dependency, and why this one
 *
 * ADR-0013 requires a new dependency to be justified. `qrcode@1.5.4` is used
 * for the **encoding only** — Reed-Solomon error correction, mask selection and
 * module placement, which is a specification's worth of arithmetic that a
 * hand-rolled version would get subtly wrong in a way no test here would catch:
 * an incorrect QR code scans as nothing, or worse, as something else. The brief
 * asked for the SVG to be generated locally in preference to a dependency where
 * that is reasonable; producing correct QR *modules* by hand is not.
 *
 * It was installed without a `minimumReleaseAgeExclude` entry, so ADR-0013's
 * 1440-minute floor applied and passed. `pnpm-workspace.yaml` is unchanged.
 *
 * # Why not `QRCode.toString(..., { type: 'svg' })`
 *
 * That returns SVG markup, which would have to be injected with
 * `dangerouslySetInnerHTML`. The input contains the user's own email address
 * (`otpauth://totp/Sentinel:user@example.com?...`), so injecting library output
 * built from it puts a string the user controls into an HTML parser. Using
 * `create()` and rendering `<rect>` elements through React keeps the value in
 * the arithmetic and never in markup: nothing here parses HTML, so there is no
 * injection surface to reason about.
 *
 * # It is not a secret channel
 *
 * The `otpauthUri` is shown as text beside this image anyway — an authenticator
 * that cannot scan is entered by hand — so the QR code adds convenience, not
 * confidentiality.
 */
export function QrCode({ value, size = 192 }: { value: string; size?: number }): ReactNode {
  const modules = useMemo(() => {
    const created = createQrCode(value, { errorCorrectionLevel: 'M' });
    const count = created.modules.size;
    const data = created.modules.data;

    const dark: { x: number; y: number }[] = [];
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] === 1) dark.push({ x: index % count, y: Math.floor(index / count) });
    }
    return { count, dark };
  }, [value]);

  // The quiet zone the specification requires: four modules on every side. A
  // QR code rendered flush to its container is unreliable to scan.
  const quiet = 4;
  const extent = modules.count + quiet * 2;

  return (
    <svg
      role="img"
      aria-label="Authenticator enrolment QR code"
      width={size}
      height={size}
      viewBox={`0 0 ${String(extent)} ${String(extent)}`}
      shapeRendering="crispEdges"
      className="rounded-[var(--radius-control)] border border-[var(--color-border)]"
    >
      {/* THE ONE PLACE IN THIS APPLICATION THAT DOES NOT USE A DESIGN TOKEN,
          and the CSS keywords are chosen so that no raw hex appears either.
          A QR code is dark-on-light by specification; painting it in theme
          colours would let a low-contrast or inverted palette produce an image
          a scanner refuses, and "the QR code does not work in dark mode" is a
          support ticket nobody would connect to a token change. It is a
          machine-readable image rather than a piece of interface. */}
      <rect width={extent} height={extent} fill="white" />
      {modules.dark.map((module) => (
        <rect
          key={`${String(module.x)}-${String(module.y)}`}
          x={module.x + quiet}
          y={module.y + quiet}
          width={1}
          height={1}
          fill="black"
        />
      ))}
    </svg>
  );
}
