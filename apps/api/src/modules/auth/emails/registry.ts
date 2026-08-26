import type { RenderedEmail } from './layout.js';
import {
  renderMfaDisabled,
  renderMfaEnabled,
  renderNewDeviceSignIn,
  renderPasswordChanged,
} from './notice.templates.js';
import {
  renderEmailVerification,
  renderInvitation,
  renderPasswordReset,
} from './token-link.templates.js';

/**
 * Every email this product sends, in one record.
 *
 * Ruling 45. The registry is not a lookup convenience — nothing dispatches
 * through it and every caller will import its template directly, with the
 * argument types that template needs. It exists so that the rules which apply
 * to *all* mail can be written once, over a list, instead of six times over six
 * templates. Six near-identical assertion blocks is how one template ships
 * without a text part: the sixth gets written by copying the fifth, and the one
 * assertion that mattered is dropped in the copy.
 *
 * `registry.spec.ts` iterates this record and asserts, for every member: three
 * non-empty parts, a text part that is prose rather than stripped markup, no
 * unreplaced placeholder, nothing that makes the recipient's client fetch from
 * the network (ruling 46), and that an attacker-chosen display name is escaped
 * into the `html` part (ruling 44). Its two sample tables are
 * `Record<EmailTemplateId, …>`, so **a seventh template added in Task 15
 * inherits all of it by existing** — adding a member here without adding its
 * samples there is a compile error.
 *
 * @see .claude/security/authentication.md §2, §5, §6, §7
 */
export const EMAIL_TEMPLATES = {
  emailVerification: renderEmailVerification,
  passwordReset: renderPasswordReset,
  invitation: renderInvitation,
  passwordChanged: renderPasswordChanged,
  mfaEnabled: renderMfaEnabled,
  mfaDisabled: renderMfaDisabled,
  newDeviceSignIn: renderNewDeviceSignIn,
} as const satisfies Readonly<Record<string, (input: never) => RenderedEmail>>;

export type EmailTemplateId = keyof typeof EMAIL_TEMPLATES;

/**
 * The three that carry a live credential in a `?token=` link, and the three
 * that carry nothing and contain no link at all.
 *
 * Split rather than derived, because the two halves obey opposite rules and a
 * template belongs to one of them by decision, not by inspection. The spec
 * asserts the two lists partition the registry exactly, so a seventh template
 * that is in neither fails a test rather than quietly escaping both rule sets.
 */
export const TOKEN_LINK_TEMPLATE_IDS = [
  'emailVerification',
  'passwordReset',
  'invitation',
] as const satisfies readonly EmailTemplateId[];

export const NOTICE_TEMPLATE_IDS = [
  'passwordChanged',
  'mfaEnabled',
  'mfaDisabled',
  'newDeviceSignIn',
] as const satisfies readonly EmailTemplateId[];
