import {
  invitationCollectionSchema,
  invitationResponseSchema,
  membershipCollectionSchema,
  membershipResponseSchema,
  organizationCollectionSchema,
  roleCollectionSchema,
  type CreateInvitationRequest,
  type InvitationCollection,
  type InvitationResponse,
  type MembershipCollection,
  type MembershipResponse,
  type OrganizationCollection,
  type RoleCollection,
  type UpdateMembershipRequest,
} from '@sentinel/contracts';
import { z } from 'zod';
import type { ApiClient } from './client';

/**
 * The organisation and membership calls `/settings/members` and the
 * organisation switcher make, each bound to the contract schema its response
 * must satisfy.
 *
 * The paths are string literals in exactly one place, and each was checked
 * against the published surface on 2026-09-07:
 * `node -e "const o=require('./apps/api/openapi.json');console.log(Object.keys(o.paths))"`.
 *
 * **Every one of these is authorised server-side.** `organization.read` gates
 * the list, `organization.manage_members` gates the member and invitation
 * writes, and `organization.manage_roles` gates a role change
 * (`api/authorization.md` §1). Nothing in this file is a permission check;
 * hiding the button that calls it prevents nothing.
 */
const API = '/api/v1';

/** A 204 has no body. See `auth-endpoints.ts` for why this is not a contract. */
const noContentSchema = z.undefined();

export function listOrganizations(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<OrganizationCollection> {
  return client.request({
    method: 'GET',
    path: `${API}/organizations`,
    responseSchema: organizationCollectionSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function listRoles(client: ApiClient, signal?: AbortSignal): Promise<RoleCollection> {
  return client.request({
    method: 'GET',
    path: `${API}/roles`,
    responseSchema: roleCollectionSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function listMembers(
  client: ApiClient,
  organizationId: string,
  signal?: AbortSignal,
): Promise<MembershipCollection> {
  return client.request({
    method: 'GET',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/members`,
    responseSchema: membershipCollectionSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function updateMemberRole(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  body: UpdateMembershipRequest,
): Promise<MembershipResponse> {
  return client.request({
    method: 'PATCH',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`,
    body,
    responseSchema: membershipResponseSchema,
  });
}

export function removeMember(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
): Promise<undefined> {
  return client.request({
    method: 'DELETE',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}`,
    responseSchema: noContentSchema,
  });
}

export function listInvitations(
  client: ApiClient,
  organizationId: string,
  signal?: AbortSignal,
): Promise<InvitationCollection> {
  return client.request({
    method: 'GET',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/invitations`,
    responseSchema: invitationCollectionSchema,
    ...(signal === undefined ? {} : { signal }),
  });
}

export function createInvitation(
  client: ApiClient,
  organizationId: string,
  body: CreateInvitationRequest,
): Promise<InvitationResponse> {
  return client.request({
    method: 'POST',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/invitations`,
    body,
    responseSchema: invitationResponseSchema,
  });
}

export function revokeInvitation(
  client: ApiClient,
  organizationId: string,
  invitationId: string,
): Promise<undefined> {
  return client.request({
    method: 'DELETE',
    path: `${API}/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
    responseSchema: noContentSchema,
  });
}
