'use client';

import { Alert, Button } from '@sentinel/ui';
import { useState, type ReactNode } from 'react';

/**
 * The exact sentence a once-only secret must carry.
 *
 * Exported and asserted by `RecoveryCodes.spec.tsx` rather than left as prose
 * inside the JSX: `api/authentication.md` §4 requires the UI to state this
 * before a once-only value is generated, and a requirement that lives only in
 * a paragraph is one an edit removes silently.
 */
export const RECOVERY_CODES_WARNING =
  'These codes will not be shown again. Save them now — each one signs you in once if you lose your authenticator.';

/**
 * THE ONE-TIME RECOVERY-CODE DISPLAY.
 *
 * `api/authentication.md` §2: `recoveryCodes` are "shown once. No endpoint
 * reads any of them back" — they are stored as Argon2id hashes, so this render
 * is genuinely the only copy that will ever exist. §4 requires the same
 * statement for API keys and the rule is the same one: a once-only secret
 * rendered without that warning is a support ticket at best.
 *
 * The codes are **not** offered through an `<a download>`: the copy button
 * writes to the clipboard, and the download builds a `Blob` the user's browser
 * saves. Nothing here sends a code anywhere — no analytics, no logging. They
 * exist in this component's props and in the DOM, and nowhere else.
 */
export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone?: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  return (
    <div className="flex flex-col gap-3" data-testid="recovery-codes">
      <Alert variant="warning">
        <span>{RECOVERY_CODES_WARNING}</span>
      </Alert>

      <ul className="grid grid-cols-1 gap-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 sm:grid-cols-2">
        {codes.map((code) => (
          <li
            key={code}
            className="font-mono text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text)]"
          >
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
              } catch {
                // A clipboard permission refusal is not an error worth an
                // alert: the codes are on the screen and can be selected. The
                // button simply does not claim success.
                setCopied(false);
              }
            })();
          }}
        >
          Copy
        </Button>

        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            // Built and revoked here rather than rendered as an `<a download>`
            // with a `blob:` href that would outlive the component.
            const blob = new Blob([`${text}\n`], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'sentinel-recovery-codes.txt';
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>

        {onDone === undefined ? null : (
          <Button type="button" onClick={onDone}>
            I have saved them
          </Button>
        )}
      </div>

      {copied ? (
        <span
          role="status"
          className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-success)]"
        >
          Copied to the clipboard.
        </span>
      ) : null}
    </div>
  );
}
