'use client';

import type { SessionSummary } from '@sentinel/contracts';
import { Alert, Badge, Button, Card, Skeleton } from '@sentinel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { listSessions, revokeOtherSessions, revokeSession } from '../api/auth-endpoints';
import { useApiClient } from '../api/provider';

export const SESSIONS_QUERY_KEY = ['sessions'] as const;

/**
 * Formats a timestamp for a human, and never throws on a bad one.
 *
 * The value has already been parsed by `isoTimestampSchema`, so it is a valid
 * UTC ISO string; the guard exists because a formatter that throws inside a
 * list row takes the whole panel down, and a date is not worth that.
 */
function when(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

/**
 * THE ACTIVE SESSION LIST, AND THE TWO REVOCATIONS.
 *
 * `ip` and `userAgent` are rendered as text through React, which escapes them.
 * That matters more here than on most screens: `User-Agent` is the one column
 * in the `Session` table an attacker chooses outright, and
 * `session.service.ts`'s cap on it says in terms that bounding the length "is
 * not the escaping; that is still owed by whatever renders it". This is that
 * renderer, and it owes nothing further because it never builds HTML from the
 * value.
 *
 * All six of `architecture/frontend.md` §6's states are here except *partial*,
 * which does not apply: the list is one request that either produced a page or
 * did not. Permission does not apply either — these are the caller's own
 * sessions and no permission gates them (`api/authentication.md` §2).
 */
export function SessionsPanel(): ReactNode {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [confirmingAll, setConfirmingAll] = useState(false);

  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: ({ signal }) => listSessions(client, {}, signal),
  });

  const revokeOne = useMutation({
    mutationFn: (sessionId: string) => revokeSession(client, sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const revokeRest = useMutation({
    mutationFn: () => revokeOtherSessions(client),
    onSuccess: () => {
      setConfirmingAll(false);
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
          Active sessions
        </h2>
        <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          Every device currently signed in to this account.
        </p>
      </div>

      {sessions.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" data-testid="sessions-skeleton">
          <span className="sr-only">Loading your sessions…</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {sessions.isError ? (
        <div className="flex flex-col gap-3">
          <Alert variant="danger">
            <span>Your sessions could not be loaded. Try again in a moment.</span>
          </Alert>
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void sessions.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {sessions.isSuccess && sessions.data.data.length === 0 ? (
        <Alert variant="info">
          <span>
            No sessions are listed, which should not be possible while you are reading this page.
            Reload to try again.
          </span>
        </Alert>
      ) : null}

      {sessions.isSuccess && sessions.data.data.length > 0 ? (
        <>
          <ul className="flex flex-col gap-2">
            {sessions.data.data.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                pending={revokeOne.isPending && revokeOne.variables === session.id}
                onRevoke={() => {
                  revokeOne.mutate(session.id);
                }}
              />
            ))}
          </ul>

          {sessions.data.pagination.hasMore ? (
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
              Only the {sessions.data.pagination.limit} most recently used sessions are shown.
              Signing out every other device below covers the rest as well.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {confirmingAll ? (
              <>
                <span
                  className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text)]"
                  role="alert"
                >
                  Sign out every device except this one?
                </span>
                <Button
                  type="button"
                  variant="danger"
                  pending={revokeRest.isPending}
                  onClick={() => {
                    revokeRest.mutate();
                  }}
                >
                  Yes, sign the others out
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setConfirmingAll(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setConfirmingAll(true);
                }}
              >
                Sign out all other devices
              </Button>
            )}
          </div>

          {revokeRest.isSuccess ? (
            <Alert variant="success">
              <span>
                {revokeRest.data.revoked === 0
                  ? 'There were no other devices to sign out.'
                  : `Signed out ${String(revokeRest.data.revoked)} other device${revokeRest.data.revoked === 1 ? '' : 's'}.`}
              </span>
            </Alert>
          ) : null}

          {revokeOne.isError || revokeRest.isError ? (
            <Alert variant="danger">
              <span>That session could not be signed out. Try again.</span>
            </Alert>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function SessionRow({
  session,
  pending,
  onRevoke,
}: {
  session: SessionSummary;
  pending: boolean;
  onRevoke: () => void;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[length:var(--text-body)] leading-[var(--leading-body)] break-all text-[var(--color-text)]">
            {session.userAgent ?? 'Unrecorded device'}
          </span>
          {session.current ? <Badge variant="info">This device</Badge> : null}
        </div>
        <span className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          {session.ip ?? 'No address recorded'} · signed in {when(session.createdAt)} · last used{' '}
          {when(session.lastSeenAt)}
        </span>
      </div>
      <Button
        type="button"
        variant={session.current ? 'secondary' : 'danger'}
        pending={pending}
        onClick={onRevoke}
      >
        {session.current ? 'Sign out this device' : 'Sign out'}
      </Button>
    </li>
  );
}
