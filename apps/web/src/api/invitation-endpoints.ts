import {
  acceptInvitationResponseSchema,
  type AcceptInvitationRequest,
  type AcceptInvitationResponse,
} from '@sentinel/contracts';
import type { ApiClient } from './client';

/**
 * `POST /api/v1/invitations/accept` — and it is the only thing in this file.
 *
 * # Why it is not in `organization-endpoints.ts`
 *
 * That file's docblock says, of everything in it: "Every one of these is
 * authorised server-side. `organization.read` gates the list,
 * `organization.manage_members` gates the member and invitation writes".
 * **None of that is true of this call**, and adding it there would falsify a
 * docblock a reader relies on. Every other invitation call there is mounted
 * under `organizations/:id/invitations` and declares
 * `organization.manage_members`; this one is mounted at `invitations/accept`,
 * declares no permission at all, and names no organisation.
 *
 * That is not an accident of routing — it mirrors D1 in
 * `apps/api/.../invitation-acceptance.controller.ts`, which put this route on
 * its own controller for exactly the same reason: the acceptor is a member of
 * nothing, so no tenant resolves and any permission would deny every request.
 * A separate module on this side keeps the two halves shaped the same way.
 *
 * The path is a string literal in exactly one place, checked against the
 * published surface on 2026-09-08:
 * `node -e "const o=require('./apps/api/openapi.json');console.log(Object.keys(o.paths))"`
 * lists `/api/v1/invitations/accept`.
 */
const API = '/api/v1';

/**
 * Redeems an invitation token and returns the membership it created.
 *
 * **The caller must already be signed in** — the route is `@AuthenticatedOnly()`
 * and the server takes the accepting user from the session cookie, never from
 * the body. `acceptInvitationRequestSchema` is `.strict()` and carries the
 * token alone; there is deliberately no address field, because the server
 * compares the *invited* address to the *authenticated* one and a
 * body-supplied address would be the whole attack.
 *
 * The response is a `Membership`, so accepting tells the client what it just
 * joined without a second request. It does **not** switch the session into that
 * organisation — `POST /api/v1/auth/switch-org` is what does that.
 */
export function acceptInvitation(
  client: ApiClient,
  body: AcceptInvitationRequest,
): Promise<AcceptInvitationResponse> {
  return client.request({
    method: 'POST',
    path: `${API}/invitations/accept`,
    body,
    responseSchema: acceptInvitationResponseSchema,
  });
}
