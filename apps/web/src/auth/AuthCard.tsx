import { Alert, Card } from '@sentinel/ui';
import type { ReactNode } from 'react';
import type { FormFailure } from './server-errors';

/**
 * The shell every authentication screen renders inside: one card, one `<h1>`,
 * one optional lead paragraph, and one place the form-level error region goes.
 *
 * `accessibility.md` §3 wants one `<h1>` per page; the `(auth)` layout renders
 * exactly one of these per route, so the heading lives here rather than being
 * re-typed six times with a different level each time.
 *
 * **Nothing rendered here is a security control.** These screens hide and show
 * affordances for the user's benefit; every one of them is re-authorised
 * server-side, and a caller who reaches an endpoint without the UI is refused
 * by the API, not by this component.
 */
export function AuthCard({
  title,
  lead,
  failure,
  children,
  footer,
}: {
  title: string;
  lead?: ReactNode;
  /** The form-level failure, if the last submission failed. */
  failure?: FormFailure | null;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <Card className="p-6">
      <h1 className="text-[length:var(--text-title)] leading-[var(--leading-title)] font-semibold text-[var(--color-text)]">
        {title}
      </h1>
      {lead === undefined ? null : (
        <p className="mt-2 text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-muted)]">
          {lead}
        </p>
      )}
      {failure === undefined || failure === null ? null : (
        <div className="mt-4">
          <FormErrorRegion failure={failure} />
        </div>
      )}
      <div className="mt-6">{children}</div>
      {footer === undefined ? null : (
        <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          {footer}
        </div>
      )}
    </Card>
  );
}

/**
 * The form-level error region.
 *
 * `Alert variant="danger"` resolves to `role="alert"`, the assertive live
 * region, so a screen reader announces a failed submission rather than leaving
 * the user to discover it. `architecture/frontend.md` §6 requires **the request
 * ID in every error state** — it is the only handle support has on the API's
 * logs, so it is rendered rather than merely carried, and it is omitted (not
 * faked) when the server never answered.
 */
export function FormErrorRegion({ failure }: { failure: FormFailure }): ReactNode {
  return (
    <Alert variant="danger">
      <div className="flex flex-col gap-1">
        <span>{failure.message}</span>
        {failure.requestId === null ? null : (
          <span className="text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
            Request ID <code>{failure.requestId}</code> — quote this to support.
          </span>
        )}
      </div>
    </Alert>
  );
}
