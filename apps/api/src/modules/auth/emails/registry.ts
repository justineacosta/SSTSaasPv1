import type { RenderedEmail } from './layout.js';
import {
  renderFailedLoginBurst,
  renderMfaDisabled,
  renderMfaEnabled,
  renderMfaRecoveryCodesRegenerated,
  renderNewDeviceSignIn,
  renderPasswordChanged,
  renderRegistrationAttempt,
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
 * into the `html` part (ruling 44). Its sample table is
 * `Record<EmailTemplateId, …>`, so **the next template added here inherits all
 * of it by existing** — adding a member below without adding its sample there
 * is a compile error.
 *
 * There are TEN members, and the count below is computed from the record above
 * rather than remembered — carry-forward ruling 108, which this docblock has
 * already broken once.
 *
 * Seven were built in Task 5 (`7918468`), the invitation Task 15 sends among
 * them. The eighth — `registrationAttempt` — is Task 8's (`6c769a4`), and it is
 * the message an address that is already registered receives instead of a
 * verification link, which is what keeps registration's response identical for
 * an address that exists and one that does not. The ninth — `failedLoginBurst`
 * — is Task 9's (`0013c01`), and it is the first thing that makes
 * `security/authentication.md` §7's "a burst notifies the account owner" true:
 * the sentence has been in that document since Phase 0 with no template that
 * could satisfy it.
 *
 * **The tenth is why this paragraph said NINE until Task 15's review caught
 * it.** `mfaRecoveryCodesRegenerated` arrived on 2026-09-02 in Task 11's fix
 * round (`7540279`), after the ordinal narrative above was written and while it
 * was still accurate — the eighth really was the eighth on 2026-08-31, and the
 * ninth really was the ninth on 2026-09-01. Nobody came back to the census. A
 * paragraph that counts by narrating its own history stays correct only if
 * every later writer reads the narration, which is exactly the failure this
 * comment now records.
 *
 * Each was added by writing one line below and one line in `registry.spec.ts`'s
 * `CASES` table, and inherited every assertion in that file by existing, which
 * is the property this registry was built for.
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
  mfaRecoveryCodesRegenerated: renderMfaRecoveryCodesRegenerated,
  newDeviceSignIn: renderNewDeviceSignIn,
  registrationAttempt: renderRegistrationAttempt,
  failedLoginBurst: renderFailedLoginBurst,
} as const satisfies Readonly<Record<string, (input: never) => RenderedEmail>>;

export type EmailTemplateId = keyof typeof EMAIL_TEMPLATES;

/**
 * The three that carry a live credential in a `?token=` link, and the seven
 * that carry nothing and contain no link at all.
 *
 * Split rather than derived, because the two halves obey opposite rules and a
 * template belongs to one of them by decision, not by inspection. The spec
 * asserts the two lists partition the registry exactly, so a template in
 * neither fails a test rather than quietly escaping both rule sets.
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
  'mfaRecoveryCodesRegenerated',
  'newDeviceSignIn',
  'registrationAttempt',
  'failedLoginBurst',
] as const satisfies readonly EmailTemplateId[];
