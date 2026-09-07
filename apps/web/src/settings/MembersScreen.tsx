'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createInvitationRequestSchema,
  SYSTEM_ROLES,
  type CreateInvitationRequest,
  type InvitationResponse,
  type MembershipResponse,
  type SystemRole,
} from '@sentinel/contracts';
import { Alert, Badge, Button, Card, Field, Input, Skeleton } from '@sentinel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import {
  createInvitation,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from '../api/organization-endpoints';
import { useApiClient } from '../api/provider';
import { FormErrorRegion } from '../auth/AuthCard';
import { applyServerErrors, type FormFailure } from '../auth/server-errors';
import { Can, useSession } from '../app/session-context';

const INVITE_FIELDS = ['email', 'roleKey'] as const;

/**
 * `/settings/members`.
 *
 * # Every affordance is gated, and the gate is UX only
 *
 * `usePermission` and `<Can>` decide what is *offered*; the API decides what
 * *happens*. `organization.manage_members` gates the invitation and removal
 * routes and `organization.manage_roles` gates the role change
 * (`api/authorization.md` §1, and the ten routes its status banner enumerates),
 * so a caller who hides nothing and posts anyway is refused with 403
 * `PERMISSION_DENIED` — plus two refusals from inside the handler that no
 * permission set predicts: granting a role whose permissions you lack, and a
 * write that would leave the organisation with no owner.
 *
 * That is why the gate is not the only story on this screen: server refusals
 * are rendered where the user can read them, because a UI that only hides
 * things cannot explain a refusal it did not anticipate.
 *
 * # Keys are organisation-scoped
 *
 * `['org', orgId, …]` per `architecture/frontend.md` §3. The organisation
 * switcher clears the whole cache anyway, so this is belt and braces — but the
 * key shape is what a future selective invalidation would need, and getting it
 * right costs nothing now.
 */
export function MembersScreen(): ReactNode {
  const session = useSession();
  const organization = session.activeOrganization;

  if (organization === null) {
    // §6's empty state. Not an error: a user can be signed in before choosing
    // or joining an organisation, and there is genuinely nothing to list.
    return (
      <div className="flex flex-col gap-4">
        <Header />
        <Alert variant="info">
          <span>
            You are not acting in an organisation yet. Choose one at the top of the page, or accept
            an invitation from an existing member.
          </span>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Header />
      <MemberList organizationId={organization.id} />
      <InvitationList organizationId={organization.id} />
    </div>
  );
}

function Header(): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="font-display text-[length:var(--text-display)] leading-[var(--leading-display)] text-[var(--color-text)]">
        Members
      </h1>
      <p className="text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-muted)]">
        Who belongs to this organisation, what they may do, and who has been invited.
      </p>
    </div>
  );
}

function MemberList({ organizationId }: { organizationId: string }): ReactNode {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManageRoles = session.permissions.includes('organization.manage_roles');
  const canManageMembers = session.permissions.includes('organization.manage_members');

  const members = useQuery({
    queryKey: ['org', organizationId, 'members'],
    queryFn: ({ signal }) => listMembers(client, organizationId, signal),
  });

  const [refusal, setRefusal] = useState<string | null>(null);

  const changeRole = useMutation({
    mutationFn: (input: { membershipId: string; roleKey: SystemRole }) =>
      updateMemberRole(client, organizationId, input.membershipId, { roleKey: input.roleKey }),
    onSuccess: () => {
      setRefusal(null);
      void queryClient.invalidateQueries({ queryKey: ['org', organizationId, 'members'] });
    },
    onError: (error: unknown) => {
      setRefusal(refusalMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: (membershipId: string) => removeMember(client, organizationId, membershipId),
    onSuccess: () => {
      setRefusal(null);
      void queryClient.invalidateQueries({ queryKey: ['org', organizationId, 'members'] });
    },
    onError: (error: unknown) => {
      setRefusal(refusalMessage(error));
    },
  });

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
        Members
      </h2>

      {members.isPending ? (
        <div aria-busy="true" data-testid="members-skeleton" className="flex flex-col gap-2">
          <span className="sr-only">Loading members…</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}

      {members.isError ? (
        <Alert variant="danger">
          <span>The member list could not be loaded. Try reloading the page.</span>
        </Alert>
      ) : null}

      {members.isSuccess && members.data.data.length === 0 ? (
        <Alert variant="info">
          <span>
            This organisation has no members yet, which normally means every invitation is still
            outstanding.
          </span>
        </Alert>
      ) : null}

      {refusal === null ? null : (
        <Alert variant="danger">
          <span role="alert">{refusal}</span>
        </Alert>
      )}

      {members.isSuccess && members.data.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {members.data.data.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              canManageRoles={canManageRoles}
              canManageMembers={canManageMembers}
              onChangeRole={(roleKey) => {
                changeRole.mutate({ membershipId: member.id, roleKey });
              }}
              onRemove={() => {
                remove.mutate(member.id);
              }}
            />
          ))}
        </ul>
      ) : null}

      {/* §6's permission state: explain what is missing rather than showing a
          page with silently absent controls. */}
      {canManageRoles && canManageMembers ? null : (
        <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          {canManageMembers
            ? 'You can invite and remove members. Changing a role needs organization.manage_roles, which an owner or admin can grant.'
            : 'You can see who belongs to this organisation. Inviting, removing and changing roles need organization.manage_members, which an owner or admin can grant.'}
        </p>
      )}
    </Card>
  );
}

function MemberRow({
  member,
  canManageRoles,
  canManageMembers,
  onChangeRole,
  onRemove,
}: {
  member: MembershipResponse;
  canManageRoles: boolean;
  canManageMembers: boolean;
  onChangeRole: (roleKey: SystemRole) => void;
  onRemove: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[length:var(--text-body)] leading-[var(--leading-body)] break-all text-[var(--color-text)]">
          {member.user.name ?? member.user.email}
        </span>
        <span className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] break-all text-[var(--color-text-muted)]">
          {member.user.email}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canManageRoles ? (
          <label className="flex items-center gap-1 text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            <span className="sr-only">Role for {member.user.email}</span>
            <select
              aria-label={`Role for ${member.user.email}`}
              value={member.roleKey}
              onChange={(event) => {
                onChangeRole(event.target.value as SystemRole);
              }}
              className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text)]"
            >
              {SYSTEM_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Badge variant="neutral">{member.roleKey}</Badge>
        )}

        <Badge variant={member.status === 'ACTIVE' ? 'info' : 'neutral'}>{member.status}</Badge>

        {canManageMembers ? (
          confirming ? (
            <>
              <Button type="button" variant="danger" onClick={onRemove}>
                Confirm removal
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
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
                setConfirming(true);
              }}
            >
              Remove
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}

function InvitationList({ organizationId }: { organizationId: string }): ReactNode {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const invitations = useQuery({
    queryKey: ['org', organizationId, 'invitations'],
    queryFn: ({ signal }) => listInvitations(client, organizationId, signal),
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeInvitation(client, organizationId, invitationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['org', organizationId, 'invitations'] });
    },
  });

  const pending = invitations.isSuccess
    ? invitations.data.data.filter(
        (invitation) => invitation.acceptedAt === null && invitation.revokedAt === null,
      )
    : [];

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h2 className="font-display text-[length:var(--text-heading)] leading-[var(--leading-heading)] text-[var(--color-text)]">
        Invitations
      </h2>

      <Can
        permission="organization.manage_members"
        fallback={
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
            Inviting somebody needs organization.manage_members. An owner or admin can grant it.
          </p>
        }
      >
        <InviteForm organizationId={organizationId} />
      </Can>

      {invitations.isPending ? (
        <div aria-busy="true" data-testid="invitations-skeleton">
          <span className="sr-only">Loading invitations…</span>
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}

      {invitations.isError ? (
        <Alert variant="danger">
          <span>Outstanding invitations could not be loaded.</span>
        </Alert>
      ) : null}

      {invitations.isSuccess && pending.length === 0 ? (
        <p className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          No invitations are outstanding.
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {pending.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onRevoke={() => {
                revoke.mutate(invitation.id);
              }}
            />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function InvitationRow({
  invitation,
  onRevoke,
}: {
  invitation: InvitationResponse;
  onRevoke: () => void;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[length:var(--text-body)] leading-[var(--leading-body)] break-all text-[var(--color-text)]">
          {invitation.email}
        </span>
        <span className="text-[length:var(--text-sm)] leading-[var(--leading-sm)] text-[var(--color-text-muted)]">
          {invitation.roleKey} · expires {new Date(invitation.expiresAt).toLocaleString()}
        </span>
      </div>
      <Can permission="organization.manage_members">
        <Button type="button" variant="secondary" onClick={onRevoke}>
          Revoke
        </Button>
      </Can>
    </li>
  );
}

function InviteForm({ organizationId }: { organizationId: string }): ReactNode {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [sent, setSent] = useState(false);

  const {
    register: field,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateInvitationRequest>({
    resolver: zodResolver(createInvitationRequestSchema),
    defaultValues: { email: '', roleKey: 'MEMBER' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSent(false);
    try {
      await createInvitation(client, organizationId, values);
      reset({ email: '', roleKey: values.roleKey });
      setSent(true);
      void queryClient.invalidateQueries({ queryKey: ['org', organizationId, 'invitations'] });
    } catch (error) {
      setFailure(applyServerErrors<CreateInvitationRequest>(error, INVITE_FIELDS, setError));
    }
  });

  return (
    <form
      noValidate
      aria-label="Invite a member"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === null ? null : <FormErrorRegion failure={failure} />}
      {sent ? (
        <Alert variant="success">
          <span>The invitation has been sent.</span>
        </Alert>
      ) : null}

      <Field label="Email address" error={errors.email?.message}>
        <Input type="email" autoComplete="email" {...field('email')} />
      </Field>

      <Field label="Role" error={errors.roleKey?.message}>
        <select
          {...field('roleKey')}
          className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text)]"
        >
          {SYSTEM_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </Field>

      <div>
        <Button type="submit" pending={isSubmitting}>
          Send invitation
        </Button>
      </div>
    </form>
  );
}

/**
 * The message a refused mutation shows.
 *
 * Two of the API's refusals here are decided inside the handler rather than by
 * a guard, so no permission set predicts them: granting a role whose
 * permissions the caller lacks (403), and a write that would leave the
 * organisation with no owner (422 `INVALID_STATE_TRANSITION`). Both come back
 * in the error envelope, and the envelope's own message is what is shown —
 * inventing a friendlier sentence here would tell the user something the API
 * did not say.
 */
function refusalMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'That change was refused.';
}
