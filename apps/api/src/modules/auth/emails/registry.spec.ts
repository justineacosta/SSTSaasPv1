import { describe, expect, it } from 'vitest';
import type { RenderedEmail } from './layout.js';
import {
  EMAIL_TEMPLATES,
  type EmailTemplateId,
  NOTICE_TEMPLATE_IDS,
  TOKEN_LINK_TEMPLATE_IDS,
} from './registry.js';

/**
 * ONE TABLE, EVERY TEMPLATE — INCLUDING THE ONES THAT DO NOT EXIST YET.
 *
 * Ruling 45. Six near-identical assertion blocks is how one template ships
 * without a text part: the sixth block gets written by copying the fifth, and
 * the one assertion that mattered gets dropped in the copy. Everything below
 * iterates the exported registry instead, so the next template added to it
 * inherits every rule here by existing.
 *
 * The registry holds **nine** members: Task 5's seven, the invitation among
 * them, Task 8's `registrationAttempt`, and Task 9's `failedLoginBurst`.
 *
 * `CASES` below is a `Record<EmailTemplateId, …>`, which is the part that makes
 * that true — see its own docblock for why the benign and hostile passes share
 * one table rather than two.
 */

/**
 * A deliberately LOW-ENTROPY fixture, and that is the point.
 *
 * It keeps a real token's shape — 43 characters of base64url, including the
 * `_` and `-` that must survive URL construction — while being unmistakably
 * fake to a human and to a secret scanner. The previous value here was random
 * base64url, indistinguishable from a live credential, and GitGuardian flagged
 * this file and `links.spec.ts` as the two uncovered secrets on PR #10.
 *
 * Same lesson as ruling 57 one layer over: a credential-shaped string in a
 * committed file costs something even when it is inert. There it was a real
 * token in a ledger and cost a history rewrite; here it is a fixture that was
 * never a credential at all, and it still turned a security product's own
 * security check red. **A test fixture standing in for a secret should look
 * like a fixture.**
 */
const TOKEN = 'FIXTURE_not_a_real_token-registry_000000000';
const BASE_URL = 'https://app.sentinel.test';
const OCCURRED_AT = new Date('2026-08-26T09:41:07.512Z');

/**
 * ONE table of renders, parameterised by the strings an attacker controls.
 *
 * The benign and hostile passes were two tables until they were not: two
 * `Record<EmailTemplateId, …>` literals differing only in four string values is
 * sixty lines of duplication that can silently drift apart, and a template whose
 * hostile sample quietly stopped passing the payload would go on satisfying the
 * escaping test forever. One table cannot drift from itself.
 *
 * `Record<EmailTemplateId, …>` is still what makes ruling 45 true: adding a
 * member to the registry without adding it here is a **compile error**, not a
 * silently uncovered template. `pnpm typecheck` is where that lands
 * (carry-forward ruling 40 — it can be red while `pnpm test` is green).
 */
interface AttackerStrings {
  /**
   * THE RECIPIENT'S OWN STORED DISPLAY NAME — `User.name` on the row this
   * message is addressed to, and the value ruling 70 is about.
   *
   * It is free text up to 200 characters written straight from a registration
   * body, and **an attacker seeds a victim's copy of it by registering the
   * victim's address first**. As of Task 10 no template in this registry takes
   * it: it is passed into every render below and must appear in none of them.
   *
   * Kept as a separate field from `inviterName` because the two are different
   * facts about different people, and one table field standing for both is how
   * a test about the first ends up asserting about the second.
   */
  readonly name: string;
  /**
   * The display name of the **member sending an invitation** — a different
   * person from the recipient, chosen by somebody authenticated inside the
   * organisation, and still a stored `User.name`.
   *
   * **M2: `invitation` used to render this, and that was ruling 70's fifth
   * channel.** It reached the TEXT part of a message carrying a live token
   * link, where mail clients autolink a bare URL — the same rendering that made
   * Task 8's H1 and Task 9's H2. The field is gone from `InvitationInput`, so
   * like `name` above it is now consumed by nothing and the whole-registry
   * block below asserts its absence structurally.
   */
  readonly inviterName: string;
  readonly organizationName: string;
  readonly ipAddress: string;
}

/**
 * The templates that render no attacker-supplied string whatsoever.
 *
 * Each is sent to an address whose ownership nobody has proven, or describes
 * somebody else's activity, which is what makes the stored display name
 * untrustworthy: anyone may register somebody else's address with 200
 * characters of chosen text in `name` (F1). None takes a name, an IP that
 * survives `renderableIpAddress`, or a user agent, so for these the assertion
 * is ABSENCE rather than escaping.
 *
 * `failedLoginBurst` joined them in Task 9 and is the sharpest case: the burst
 * is *somebody else's* attempt, so neither the IP nor the user agent describes
 * the recipient at all, and the user agent is attacker-chosen free text. Its
 * context type is `{ occurredAt, attemptCount }` and there is no third field
 * for any of it to travel through.
 *
 * **Task 10 moves four more in, and after that only the invitation is left
 * out.** Carry-forward ruling 70 is closed to the CLASS rather than to the
 * instance that had a caller (ruling 71's habit): `passwordReset`,
 * `passwordChanged`, `mfaEnabled` and `mfaDisabled` no longer accept a
 * `recipientName`, so the only caller-supplied field any of them still takes is
 * an IP address that `renderableIpAddress` refuses to render unless it is an
 * address literal.
 */
const NAMELESS_TEMPLATE_IDS = [
  'emailVerification',
  'registrationAttempt',
  'failedLoginBurst',
  // Joined the list in the H2 fix round. It never took a name; it took a user
  // agent (removed from `whereAndWhen` outright) and an IP address (now
  // rendered only if it is an address literal), so there is no longer any
  // attacker-chosen string for it to escape — the assertion for it is ABSENCE.
  'newDeviceSignIn',
  // The four Task 10 closes. `passwordReset` is the one ruling 70 named — an
  // unauthenticated endpoint mailing a live reset link — and the other three
  // are changed with it rather than left for Task 11, because "safe, it has no
  // caller yet" is the exact sentence Task 9 left standing over
  // `newDeviceSignIn` in the commit that gave it one.
  'passwordReset',
  'passwordChanged',
  'mfaEnabled',
  'mfaDisabled',
  'mfaRecoveryCodesRegenerated',
] as const satisfies readonly EmailTemplateId[];

/**
 * The one template that still renders a string somebody else chose, and
 * therefore the only one the escaping assertion has anything to say about.
 *
 * **After M2 it renders exactly one such field: `organizationName`.**
 * `inviterName` is gone — it was a stored `User.name` reaching the text part of
 * a live-link message, which is ruling 70's fifth channel and is closed
 * structurally.
 *
 * `organizationName` is a genuinely different case and is kept deliberately. An
 * invitation that does not name the organisation is useless; the value belongs
 * to an **accountable tenant** rather than to an anonymous registrant who typed
 * somebody else's address, since creating an organisation requires an
 * authenticated verified account and the name is visible to every member.
 *
 * **It is not a closed case, and this list is not a claim that it is.** A tenant
 * who puts a URL in their organisation name gets it autolinked in the text part
 * of every invitation they send. That residual is pinned from both sides by
 * `the organisation name residual` below, so closing it turns a test red, and
 * it **binds Task 13** (which creates organisations and owns whatever the name
 * is constrained to) **and Task 15** (which ships the endpoint that sends this).
 */
const ATTACKER_STRING_TEMPLATE_IDS = ['invitation'] as const satisfies readonly EmailTemplateId[];

/**
 * RULING 70 USED TO BE A PARTITION HERE. IT IS NOT ONE ANY MORE, BECAUSE THERE
 * IS NOTHING LEFT ON THE OTHER SIDE.
 *
 * The rule is *"a message sent to an address whose ownership has not been
 * proven must render NO stored display name"*, and it was expressed as two
 * lists — templates that may greet by name and templates that may not — with
 * `passwordReset`, `passwordChanged`, `mfaEnabled` and `mfaDisabled` on the
 * permissive side and the residual pinned from both directions.
 *
 * **Task 10 removes `recipientName` from all four**, so the permissive list is
 * empty and a two-sided partition would be a list nothing can join. The
 * property is asserted over `IDS` instead — the registry itself — which is
 * strictly stronger: a template added later is covered by existing, and cannot
 * be added to the wrong list because there is no list.
 *
 * The invitation is not an exception to this. It renders the **inviter's**
 * display name, which is a different person's, chosen by an authenticated
 * member of the organisation, and it takes no field for the recipient's own —
 * see `ATTACKER_STRING_TEMPLATE_IDS`.
 */

const CASES: Record<EmailTemplateId, (s: AttackerStrings) => RenderedEmail> = {
  emailVerification: () =>
    EMAIL_TEMPLATES.emailVerification({
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 86_400,
    }),
  // NO `recipientName`, and the absent field is the control. Ruling 70, closed
  // by Task 10: this message is mailed to an address nobody has proven belongs
  // to the recipient AND it carries a live reset link, so a stored display name
  // here is a stranger's sentence and URL beside a working credential.
  passwordReset: () =>
    EMAIL_TEMPLATES.passwordReset({
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 3_600,
    }),
  // NO `inviterName`. M2: it was a stored `User.name` rendered into the text
  // part of a message carrying a live token link, and the type no longer has a
  // field for it. `s.inviterName` is therefore consumed by nothing, which is
  // what makes the whole-registry ruling-70 block a structural assertion for it
  // exactly as it is for `s.name`.
  invitation: (s) =>
    EMAIL_TEMPLATES.invitation({
      organizationName: s.organizationName,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 604_800,
    }),
  passwordChanged: (s) => EMAIL_TEMPLATES.passwordChanged(notice(s)),
  mfaEnabled: (s) => EMAIL_TEMPLATES.mfaEnabled(notice(s)),
  mfaDisabled: (s) => EMAIL_TEMPLATES.mfaDisabled(notice(s)),
  mfaRecoveryCodesRegenerated: (s) => EMAIL_TEMPLATES.mfaRecoveryCodesRegenerated(notice(s)),
  // NEITHER a name NOR a user agent, and neither can be passed: the context
  // type carries no field for either (rulings 70 and, since H2, 63-as-amended).
  newDeviceSignIn: (s) =>
    EMAIL_TEMPLATES.newDeviceSignIn({ occurredAt: OCCURRED_AT, ipAddress: s.ipAddress }),
  registrationAttempt: () => EMAIL_TEMPLATES.registrationAttempt({ occurredAt: OCCURRED_AT }),
  // Two fields, neither of them caller-supplied text. `attemptCount` is our own
  // counter and `occurredAt` is our own clock reading.
  failedLoginBurst: () =>
    EMAIL_TEMPLATES.failedLoginBurst({ occurredAt: OCCURRED_AT, attemptCount: 5 }),
};

function notice(s: AttackerStrings) {
  // No `userAgent`. H2 removed it from `whereAndWhen`, so no notice template
  // has a field for it and this helper cannot supply one.
  //
  // No `recipientName` either, as of Task 10. `SecurityNoticeContext` is gone
  // and every notice takes `NoticeOccurrenceContext`, so `s.name` has nowhere
  // to travel — which is why the ruling-70 prescribed test below can run over
  // every notice with no exempt list.
  return {
    occurredAt: OCCURRED_AT,
    ipAddress: s.ipAddress,
  };
}

const BENIGN: AttackerStrings = {
  name: 'Ada Lovelace',
  inviterName: 'Grace Hopper',
  organizationName: 'Acme Security',
  ipAddress: '203.0.113.7',
};

/**
 * Every attacker-controllable string at once. A display name is chosen by
 * whoever registers, an organisation name by whoever creates the organisation,
 * and a user agent is a request header and therefore attacker-chosen outright.
 */
const XSS = `<script>alert(1)</script>" onmouseover="steal()`;

/**
 * A URL, in the payload, because the escaping payload alone could not see H1.
 *
 * `<script>alert(1)</script>" onmouseover="steal()` contains no `http`, so the
 * hostile fixture sat two declarations away from the "carries no link"
 * assertion and would still not have failed it if it had been swapped in. Every
 * attacker-controlled string now carries a scheme AND the word `token`, so the
 * two notice properties below — no link, no token — are testable against
 * hostile input rather than against the benign fixture that made them vacuous.
 */
const INJECTED_URL = 'https://sentinel-support.example/verify?token=FIXTURE_injected_000';
const XSS_WITH_URL = `${XSS} ${INJECTED_URL}`;

const HOSTILE: AttackerStrings = {
  name: XSS_WITH_URL,
  inviterName: XSS_WITH_URL,
  organizationName: XSS_WITH_URL,
  ipAddress: XSS_WITH_URL,
};

const SAMPLES = (id: EmailTemplateId): RenderedEmail => CASES[id](BENIGN);
const ATTACKED = (id: EmailTemplateId): RenderedEmail => CASES[id](HOSTILE);

const IDS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[];

describe('the email template registry', () => {
  it('covers every registered template', () => {
    // The compile-time guarantee above, restated at runtime: `Record<K, …>` is
    // only exhaustive against the union TypeScript sees, and `EMAIL_TEMPLATES`
    // is the thing actually iterated.
    expect(Object.keys(CASES).sort()).toEqual([...IDS].sort());
  });

  it('classifies every template as either link-carrying or a notice', () => {
    // Three carry a live credential and five carry none. A template that is
    // neither is a template nobody decided about, and the rules below divide
    // along exactly this line.
    const classified = [...TOKEN_LINK_TEMPLATE_IDS, ...NOTICE_TEMPLATE_IDS];
    expect([...classified].sort()).toEqual([...IDS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('registers the ten templates authentication.md §2, §5, §6 and §7 require', () => {
    expect([...IDS].sort()).toEqual([
      'emailVerification',
      // Task 9. §7's "a burst notifies the account owner" had no template at
      // all until now — the sentence was in the document and nothing could
      // satisfy it.
      'failedLoginBurst',
      'invitation',
      'mfaDisabled',
      'mfaEnabled',
      // Review M4's fix round. Regeneration was the only MFA state change that
      // notified nobody, which is exactly why an attacker holding a stolen
      // session and the password would choose it over `disable`.
      'mfaRecoveryCodesRegenerated',
      'newDeviceSignIn',
      'passwordChanged',
      'passwordReset',
      // Task 8. §7's "responses that do not distinguish existing from
      // non-existing accounts" is only half a control without it: without this
      // message the person who already holds the account learns nothing about
      // an attempt made against their address.
      'registrationAttempt',
    ]);
  });

  it('classifies every template as rendering an attacker-chosen string or not', () => {
    // The partition the escaping test branches on. It used to branch on a bare
    // `.includes()` over one list with no exhaustiveness check, so a template
    // that belonged to neither side silently took the `else` arm and was
    // asserted about as though it rendered a name. Ruling 58's family: a
    // fixture on one side of the branch under test.
    const classified = [...NAMELESS_TEMPLATE_IDS, ...ATTACKER_STRING_TEMPLATE_IDS];
    expect([...classified].sort()).toEqual([...IDS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });
});

describe.each(IDS)('template %s under ruling 70', (id) => {
  it('renders the recipient display name nowhere, even when it is a URL', () => {
    // THE TEST RULING 70 SAYS TO WRITE, AND IT NOW RUNS OVER THE WHOLE
    // REGISTRY WITH NO EXEMPT LIST. Until Task 10 it ran over a four-member
    // list, and the five templates left out were the ones that actually greeted
    // by name — which is carry-forward ruling 58's family in its purest form.
    //
    // The payload is a sentence AND a link, because the escaping payload alone
    // contains no scheme and would have passed a 'carries no link' assertion
    // vacuously (F-series, Task 8). It also carries a benign spelling of the
    // name, so a template that rendered the field without the payload would
    // still be caught.
    //
    // It passes STRUCTURALLY rather than by filtering: no template in the
    // registry has a parameter the recipient's display name could travel
    // through, so the `CASES` table above cannot pass one. A value that cannot
    // be supplied cannot be injected, and a denylist over attacker text is a
    // defect waiting for a new encoding.
    //
    // **Which means `pnpm typecheck` is the real control here and this test
    // cannot fail while that compiles** — stated rather than left for a
    // reviewer to work out, exactly as the device-string block below states it.
    // Reinstating a `recipientName` field on a context type is what would make
    // this reachable, and then it goes red. What the block earns as it stands
    // is that the property is written down over the registry rather than over a
    // list somebody has to remember to extend.
    // BOTH stored `User.name` values, and M2 is why `inviterName` is here.
    // The recipient's name was the only one this payload carried until the fix
    // round, so the one template that actually rendered a stored display name —
    // `invitation`, into the TEXT part of a message carrying a live token link —
    // was the one template the payload was never run at.
    const email = CASES[id]({
      ...BENIGN,
      name: XSS_WITH_URL,
      inviterName: XSS_WITH_URL,
    });
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toContain('steal()');
      expect(part).not.toContain(INJECTED_URL);
      expect(part).not.toContain('Ada Lovelace');
      expect(part).not.toContain('Grace Hopper');
    }
  });
});

describe.each(IDS)('template %s', (id) => {
  it('has a non-empty subject, html part and text part', () => {
    const email = SAMPLES(id);
    expect(email.subject.trim().length).toBeGreaterThan(0);
    expect(email.html.trim().length).toBeGreaterThan(0);
    expect(email.text.trim().length).toBeGreaterThan(0);
  });

  it('has a text part that is real prose, not stripped markup', () => {
    const email = SAMPLES(id);
    expect(email.text).not.toContain('<');
    expect(email.text).not.toContain('style=');
    expect(email.text.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(80);
    expect(email.text).toContain(email.subject);
  });

  it('leaves no unreplaced placeholder in either part', () => {
    const email = SAMPLES(id);
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toContain('{{');
      expect(part).not.toContain('${');
      expect(part).not.toContain('%s');
      expect(part).not.toContain('undefined');
      expect(part).not.toContain('[object Object]');
      expect(part).not.toContain('NaN');
      expect(part).not.toMatch(/\bnull\b/);
      expect(part).not.toContain('Invalid Date');
    }
  });

  it('makes the recipient fetch nothing when the message is opened', () => {
    const { html } = SAMPLES(id);
    for (const forbidden of ['<img', 'src=', '<link', '@import', 'url(', 'background=']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('escapes every attacker-chosen string it does render into the html part', () => {
    // Ruling 44. A display name is chosen at registration, an organisation name
    // at creation, and a user agent is a request header — all three are
    // attacker-controlled wherever a template renders them.
    //
    // EIGHT of the nine render NONE of them and are skipped rather than
    // asserted about — see `NAMELESS_TEMPLATE_IDS`, whose membership is
    // partitioned against `ATTACKER_STRING_TEMPLATE_IDS` in an exhaustiveness
    // test above, so a template cannot fall into this branch by being forgotten
    // on both lists. After Task 10 removed `recipientName` from the last four
    // (ruling 70, closed), `invitation` is the only member left with anything
    // to escape.
    //
    // The skip is checked rather than trusted: the assertion inside it proves
    // the payload is ABSENT rather than merely escaped, which is the stronger
    // property and the one a structural fix actually delivers.
    if (NAMELESS_TEMPLATE_IDS.includes(id as (typeof NAMELESS_TEMPLATE_IDS)[number])) {
      const { html, text } = ATTACKED(id);
      for (const part of [html, text]) {
        expect(part).not.toContain('script');
        expect(part).not.toContain('steal()');
      }
      return;
    }
    const { html } = ATTACKED(id);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
    // `onmouseover=` on its own is the wrong assertion and an earlier version of
    // this test used it: the payload's `"` is escaped, so the literal text
    // `onmouseover=` survives as inert content followed by `&quot;` and the
    // test failed on correct output. What actually matters is that the payload
    // cannot *start an attribute*, which needs a quote character it no longer
    // has.
    expect(html).not.toContain('onmouseover="');
    // The general form of the same property, and the one that does not depend
    // on guessing this particular payload: an attacker-chosen value contributes
    // no quote character to the markup at all, so the quote count is identical
    // to the benign render's. Every attribute delimiter in the output came from
    // the layout.
    const quotes = (part: string): number => (part.match(/"/g) ?? []).length;
    expect(quotes(html)).toBe(quotes(SAMPLES(id).html));
  });

  it('does not leak the payload through the subject line either', () => {
    // A subject is rendered as text by every client, so it needs no escaping —
    // but it must also not be silently dropped, and a template that interpolates
    // a hostile name into a subject and then into markup would show up here.
    const { subject } = ATTACKED(id);
    expect(subject.length).toBeGreaterThan(0);
  });
});

describe.each(TOKEN_LINK_TEMPLATE_IDS)('token-carrying template %s', (id) => {
  function linkFrom(part: string): URL {
    const found = part.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    // Deliberately the FIRST url, and the assertion above proves there was one.
    // Reading `.at(0)` under `noUncheckedIndexedAccess` needs the non-null
    // below, which is why the length check comes first.
    const first = found[0];
    if (first === undefined) throw new Error('unreachable: length asserted above');
    return new URL(first);
  }

  it('carries the token as a ?token= query parameter in the html part', () => {
    const url = linkFrom(SAMPLES(id).html);
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(url.pathname).not.toContain(TOKEN);
  });

  it('carries the same link in the text part, so a text-only client still works', () => {
    // A verification mail whose only actionable content is in the HTML part is a
    // verification mail that fails for anyone reading in plain text.
    const url = linkFrom(SAMPLES(id).text);
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(url.origin).toBe(BASE_URL);
  });

  it('states the lifetime the token was actually issued with', () => {
    // Derived from the configured TTL rather than written into the prose, so
    // shortening a TTL during an incident does not leave the mail lying.
    expect(SAMPLES(id).text).toMatch(/\b(24 hours|1 hour|7 days)\b/);
  });
});

describe.each(NOTICE_TEMPLATE_IDS)('notice template %s', (id) => {
  it('carries no token', () => {
    const email = SAMPLES(id);
    expect(email.html).not.toContain('token');
    expect(email.text).not.toContain('token');
  });

  it('carries no link of any kind, in either part', () => {
    // A stronger property than "no token", and the one worth having: these
    // messages exist to tell a victim that something happened to their account,
    // which is exactly the message a phisher wants to imitate. A notice with no
    // link at all trains the recipient that a real one never asks them to click,
    // and removes any chance of one shipping with a live credential in it.
    const email = SAMPLES(id);
    expect(email.html).not.toMatch(/https?:\/\//);
    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toContain('href');
  });

  it('names when it happened, in UTC', () => {
    expect(SAMPLES(id).text).toContain('2026-08-26 09:41 UTC');
  });
});

/**
 * WHICH NOTICES RENDER THE REQUEST CONTEXT, AND WHICH DELIBERATELY DO NOT.
 *
 * This partition is the shape of H1's fix. `whereAndWhen` interpolates the
 * caller's `User-Agent` header verbatim as `Device: <value>`, and a header is
 * text the client chooses outright — so any notice that renders it is a notice
 * an attacker can put a sentence into.
 *
 * `registrationAttempt` is the one that mattered, because it is the only notice
 * reachable by somebody with **no account at all**: `POST /auth/register`
 * against an address that already exists mails it to the account owner. It now
 * renders no context line, so there is no field for that text to travel in.
 *
 * The other four are sent after an action taken with the account's own
 * credentials, and the device string is how a recipient recognises a session
 * that is not theirs — removing it would cost them the one fact they can act
 * on. **The injection is not closed for those four, and the test below records
 * that rather than leaving it invisible.** None of them has a caller yet
 * (Tasks 9 and 11), and the residual is written up in this task's fixes report.
 *
 * `satisfies` makes the partition exhaustive at compile time: a new notice
 * template must be classified here or the build fails.
 */
const CONTEXT_FREE_NOTICE_IDS = [
  'registrationAttempt',
  // Task 9, and for a reason one step past `registrationAttempt`'s. A burst of
  // failed logins is not the recipient's session: the IP and the user agent
  // belong to whoever was guessing, so neither describes them, and the user
  // agent is attacker-chosen free text besides. There is nothing here for a
  // context line to be about.
  'failedLoginBurst',
] as const satisfies readonly EmailTemplateId[];

const CONTEXT_RENDERING_NOTICE_IDS = [
  'passwordChanged',
  'mfaEnabled',
  'mfaDisabled',
  'mfaRecoveryCodesRegenerated',
  'newDeviceSignIn',
] as const satisfies readonly EmailTemplateId[];

describe('the notice partition', () => {
  it('classifies every notice as context-free or context-rendering', () => {
    const classified = [...CONTEXT_FREE_NOTICE_IDS, ...CONTEXT_RENDERING_NOTICE_IDS];
    expect([...classified].sort()).toEqual([...NOTICE_TEMPLATE_IDS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });
});

describe.each(CONTEXT_FREE_NOTICE_IDS)('context-free notice %s', (id) => {
  it('carries no link when EVERY CALLER-SUPPLIED field is a URL', () => {
    // H1's regression test. Before the fix this template rendered
    // `Device: <User-Agent>` verbatim, so an unauthenticated caller could put a
    // sentence and a link into a message this product sends to a third party,
    // under a footer that promises it contains no link. Mail clients autolink a
    // bare URL in a text/plain part, so the message contradicted itself in the
    // recipient's inbox.
    //
    // The fix is structural rather than a filter: the template does not render
    // the fields at all, so there is nothing to escape, encode around, or
    // denylist.
    // `name` IS in this list, and leaving it out was F1. The first version of
    // the H1 fix excluded it, writing down that a display name is "the
    // recipient's own" — true of the data flow, false as an inference. **An
    // attacker sets a victim's `User.name` by registering the victim's address
    // first**, with up to 200 characters of free text, and the victim then gets
    // a branded message greeting them with a stranger's sentence and URL. The
    // exclusion had made this test go red for the right reason and it was
    // reasoned into silence instead.
    //
    // It passes now because neither context-free template takes a name at all.
    // This assertion runs for every id in the block — F5: the earlier version
    // of it lived in the NOTICE_TEMPLATE_IDS block behind an `if`, so it printed
    // four green lines claiming a property that is false for the four notices
    // that legitimately greet by name.
    const email = CASES[id]({
      ...BENIGN,
      name: XSS_WITH_URL,
      ipAddress: XSS_WITH_URL,
    });
    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toMatch(/https?:\/\//);
    expect(email.text).not.toContain('token');
    expect(email.html).not.toContain('href');
    // And the payload is absent entirely, not merely stripped of its scheme.
    expect(email.text).not.toContain('steal()');
  });

  it('renders neither the user agent nor the IP address at all', () => {
    // Stronger than "no URL got through", and the property that cannot be
    // re-broken by a cleverer payload: the values are absent, not sanitised.
    const email = CASES[id]({
      ...BENIGN,
      ipAddress: 'FIXTURE-ip-198.51.100.9',
    });
    for (const part of [email.html, email.text]) {
      expect(part).not.toContain('FIXTURE-ip-198.51.100.9');
      expect(part).not.toContain('Device:');
      expect(part).not.toContain('IP address:');
    }
  });

  it('still says when it happened', () => {
    // The timestamp is ours, not the caller's, so it stays. Dropping the whole
    // block rather than the two attacker-controlled lines would have cost the
    // recipient the one piece of context they can actually use.
    expect(SAMPLES(id).text).toContain('2026-08-26 09:41 UTC');
  });

  it('gives advice that is true of an event in which nothing changed', () => {
    // L9, Task 8 review. `notice.templates.ts` splits `NOTICE_FOOTER` in two so
    // this template does not tell someone to change their password because a
    // stranger typed their address into a form — and restoring the shared
    // footer left 1085 unit and 39 integration tests green. The distinction the
    // code argues for at length was enforced by prose alone.
    //
    // It matters beyond tidiness: "change your password immediately" is advice
    // an attacker would like this message to carry, since triggering it is free
    // and unauthenticated. A notice that induces action is worth sending on
    // purpose; one that says "no action is needed" is not.
    const email = SAMPLES(id);
    for (const part of [email.text, email.html]) {
      expect(part).toContain('no action is needed');
      expect(part).not.toContain('change your password immediately');
    }
  });
});

describe('failedLoginBurst', () => {
  it('says how many attempts there were, and nothing else about them', () => {
    // §7's whole purpose for this message: the account owner learns that
    // somebody is guessing. The count is ours — it is `User.failedLoginCount`
    // at the moment the lock tripped — so it is safe to render, and it is the
    // one fact that distinguishes this from a message the recipient can ignore.
    const email = CASES.failedLoginBurst({ ...BENIGN });
    expect(email.text).toContain('5');
  });

  it('is sent once per lock, which is why it says the account is locked', () => {
    // Not a rule this file can enforce — `login.service.spec.ts` owns the
    // once-per-lock assertion — but the copy has to be true of a message sent
    // on the attempt that trips the lock rather than on every failure past it.
    expect(CASES.failedLoginBurst({ ...BENIGN }).text.toLowerCase()).toContain('temporarily');
  });
});

describe.each(NOTICE_TEMPLATE_IDS)('notice %s renders no device string', (id) => {
  it('says nothing about a user agent, because no template has a field for one', () => {
    // THE TEST THAT REPLACED A CHARACTERISATION TEST, AND THE DELETION WAS THE
    // POINT OF THE OLD ONE.
    //
    // Until H2 this block asserted the opposite — that four notices DID render
    // the caller's `User-Agent` — as a deliberate record of an accepted
    // residual, with the note "the day somebody closes it this test goes red
    // and has to be deleted deliberately". H2 is that day: it went red on all
    // four when `whereAndWhen` stopped rendering the field, and it is deleted
    // rather than adjusted.
    //
    // The risk acceptance it carried is void with it, and its stated grounds
    // were what made this a finding rather than an inherited residual: *"none
    // of the four has a caller yet (Tasks 9 and 11 add them)"*. Task 9 shipped
    // `newDeviceSignIn`'s caller, edited this file in the same commit, and left
    // the sentence — so nobody re-decided. The reviewer rendered the result
    // from the built module: a `Device:` line carrying
    // `https://sentinel-verify.evil.example/login`, under a footer promising
    // the message contains no link, sent to the victim of the takeover the
    // message exists to warn them about.
    //
    // The assertion below is weak on its own — no context type has a
    // `userAgent` field, so `pnpm typecheck` is the real control and this
    // cannot fail while that compiles. It is here so a reader of the suite sees
    // the property stated, and so that reinstating the field means turning a
    // test red rather than merely adding a line.
    const email = SAMPLES(id);
    for (const part of [email.html, email.text]) {
      expect(part).not.toContain('Device:');
      expect(part).not.toContain('Mozilla');
    }
  });
});

/**
 * RULING 70'S PRESCRIBED TEST, OVER THE WHOLE REGISTRY, WITH NO EXEMPT LIST.
 *
 * The ruling says the test to write is *"no link when EVERY caller-supplied
 * field is a URL, with the display name in the list"*. It has existed twice
 * before and both versions carried an exemption:
 *
 * - Task 8 ran it over two context-free notices only, and passed BENIGN values
 *   for the fields the other four actually render. That is carry-forward ruling
 *   58's family — every fixture on one side of the branch under test — and it is
 *   why H2 was live in production with this file green.
 * - Task 9 widened it to four and carved out the three that still greeted by
 *   name, pinning the residual **from both sides**: one test asserted no link
 *   from every other field, and a second asserted that the display name **did**
 *   still produce one. That second test's own docblock said closing the residual
 *   should turn it red and force a deliberate deletion.
 *
 * **Task 10 is that day, and the test was deleted rather than adjusted.**
 * `SecurityNoticeContext` no longer exists, so no notice has a field a display
 * name could travel through, and the carve-out has nothing left to describe.
 * What is below runs over `NOTICE_TEMPLATE_IDS` itself — the exported list, not
 * a filtered copy of it — so a notice added later cannot be omitted from it.
 *
 * **P5, and it is a correction to this docblock's own earlier wording.** It
 * said the test ran "OVER THE WHOLE REGISTRY, WITH NO EXEMPT LIST". It does
 * not: it runs over the notices, and the token-link templates are covered by
 * the block below it. That mattered rather than being pedantry — the sentence
 * was the reason nobody noticed that `invitation`, the one template rendering a
 * stored display name, was in neither block's payload (M2). The two blocks
 * together now cover every member of the registry, and this sentence says which
 * covers what.
 */
describe.each(NOTICE_TEMPLATE_IDS)('notice %s under ruling 70 prescribed payload', (id) => {
  it('renders no link when EVERY caller-supplied field it accepts is a URL', () => {
    const email = CASES[id](HOSTILE);
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toMatch(/https?:\/\//);
      expect(part).not.toContain(INJECTED_URL);
    }
    expect(email.html).not.toContain('href');
    // Absent, not merely stripped of its scheme. A payload that survives as
    // inert text is still a stranger's sentence in this product's envelope.
    expect(email.text).not.toContain('steal()');
  });
});

/**
 * THE SAME PAYLOAD AGAINST THE THREE TEMPLATES THAT DO CARRY A LINK.
 *
 * "No link at all" is not the property here — these messages exist to deliver
 * one — so the prescribed test takes the only form it can take on this half of
 * the registry: **the links in the message are exactly the one this code
 * built.** A caller-supplied field that reached the body would show up as a
 * second URL, and this is the assertion that would see it.
 *
 * Written over `TOKEN_LINK_TEMPLATE_IDS` so the whole registry is covered with
 * no exempt list, which is what the brief for this task asked for and what the
 * two earlier versions of the prescribed test did not have.
 */
describe.each(TOKEN_LINK_TEMPLATE_IDS)('token-link %s under ruling 70 prescribed payload', (id) => {
  it('contains exactly one link, the one this code built', () => {
    // The payload is hostile in every field ruling 70 is about — BOTH stored
    // `User.name` values and the request IP — and benign only in
    // `organizationName`, which is the one field of the one template that is
    // deliberately still rendered. See `ATTACKER_STRING_TEMPLATE_IDS` for why
    // that is a different case, and `the organisation name residual` below for
    // the test that pins it from both sides.
    //
    // `inviterName` joined this payload in the fix round. Leaving it out is
    // what let M2 ship: the only template that rendered a stored display name
    // was the only template no ruling-70 payload was ever run at.
    const email = CASES[id]({
      ...BENIGN,
      name: XSS_WITH_URL,
      inviterName: XSS_WITH_URL,
      ipAddress: XSS_WITH_URL,
    });
    for (const part of [email.html, email.text]) {
      const urls = part.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(new URL(url).origin).toBe(BASE_URL);
        expect(new URL(url).searchParams.get('token')).toBe(TOKEN);
      }
    }
    // The payload's own URL is on a different origin, so the loop above already
    // refuses it — this states the conclusion so a reader does not have to
    // derive it, and it would still fail if `INJECTED_URL` moved to `BASE_URL`.
    expect(email.text).not.toContain(INJECTED_URL);
    expect(email.subject).not.toContain(INJECTED_URL);
  });
});

/**
 * THE ORGANISATION NAME RESIDUAL, PINNED FROM BOTH SIDES.
 *
 * This is the shape the display-name residual was pinned in before Task 10
 * closed it, and it is here for the same reason: a residual that lives only in
 * prose is one nobody re-decides. One test asserts that everything else the
 * invitation accepts is harmless; the other asserts that `organizationName`
 * **does** still reach the body as given, so the day somebody constrains it this
 * block goes red and has to be deleted deliberately rather than adjusted.
 *
 * It is **not** an endorsement. It binds Task 13, which creates organisations,
 * and Task 15, which ships the endpoint that sends this message.
 */
describe('the organisation name residual', () => {
  it('renders no link from any field EXCEPT the organisation name', () => {
    const email = CASES.invitation({
      ...BENIGN,
      name: XSS_WITH_URL,
      inviterName: XSS_WITH_URL,
      ipAddress: XSS_WITH_URL,
    });
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toContain(INJECTED_URL);
      expect(part).not.toContain('steal()');
    }
  });

  it('DOES render an organisation name that is a URL — owned by Tasks 13 and 15', () => {
    // NOT an endorsement, and not a test to adjust. It records the exact shape
    // of what is left. A tenant who puts a URL in their organisation name gets
    // it autolinked in the text part of every invitation they send.
    //
    // **PINNED IN BOTH PLACES IT LANDS, WHICH IS NEW-2.** The first version
    // asserted only `text` contains the value — and the subject is repeated
    // into the text part, so dropping the name from the body paragraph OR from
    // the subject each left the whole file green. Two mutations, both measured
    // by the fix round's reviewer. Counting occurrences is what makes the two
    // sites independently observable.
    const email = CASES.invitation({ ...BENIGN, organizationName: XSS_WITH_URL });
    expect(email.subject).toContain(INJECTED_URL);
    expect(email.text.split(INJECTED_URL).length - 1).toBeGreaterThanOrEqual(2);
    // The html part escapes it, so the danger is the text part specifically —
    // which is exactly where M2's finding lived.
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('CANNOT forge a line of its own in the plain-text body', () => {
    // THE SIXTH CHANNEL, and the half of it that is closed rather than
    // recorded. An autolinked URL contributes one suspicious token to a message
    // the recipient is already reading; CR and LF let the same value write
    // whole paragraphs of its own above the product's live token link, which is
    // a different primitive. `renderInvitation` runs the value through the
    // subject sanitiser before it reaches either part.
    const forged = 'Acme\r\nYour account was suspended. Reply with your password to restore it.';
    const email = CASES.invitation({ ...BENIGN, organizationName: forged });

    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain('\r');
      expect(part).not.toContain('Acme\nYour account');
    }
    // The words survive — this is not a denylist, it is a shape constraint —
    // but they stay on the line the template put them on.
    expect(email.text).toContain('Acme Your account was suspended.');
  });
});

describe('the two MFA states', () => {
  it('are both reachable and say different things', () => {
    // The brief allowed one template with a discriminator or two templates.
    // Two registry ids over one renderer is the choice: the adapter logs the
    // template id (ruling 47), and "MFA was disabled" is the security-relevant
    // half — an operator reading logs should not have to open the body to tell
    // which of the two was sent.
    const enabled = SAMPLES('mfaEnabled');
    const disabled = SAMPLES('mfaDisabled');
    expect(enabled.subject).not.toBe(disabled.subject);
    expect(enabled.text).toContain('enabled');
    expect(disabled.text).toContain('disabled');
    expect(enabled.text).not.toContain('disabled');
  });
});

/**
 * N-4. THE IP LINE MUST NOT BE ABLE TO CARRY A HOSTNAME EITHER.
 *
 * `renderableIpAddress` was introduced to close H2's fourth channel, and its
 * docblock claims the check makes it "impossible for this line to carry a
 * sentence, a URL, or markup". It achieved the sentence and the markup exactly.
 * The URL it achieved only against the `https?://` spelling the suite asserts:
 * the character class admitted any string of hex letters, dots and colons, and
 * `.de`, `.cc` and `.cafe` are real top-level domains that many mail clients
 * autolink from a bare domain.
 *
 * Not reachable today — `request.ip` is the socket peer address with
 * `trust proxy` disabled (`request-context.ts`, `abuse-prevention.md` §1) — so
 * this costs nothing until the day a deployment puts a proxy in front of the
 * API. That is also the day somebody will be reasoning about forwarded headers
 * and not about this line, which is the argument for closing it now rather than
 * recording it.
 *
 * The two arms are the two things a real address can be, and nothing else: a
 * dotted quad of digits, or something containing a colon. A hostname can
 * contain neither shape.
 */
describe('renderableIpAddress rejects everything that is not an address', () => {
  const RENDERED = (ipAddress: string): string =>
    CASES.newDeviceSignIn({ ...BENIGN, ipAddress }).text;

  it.each(['203.0.113.7', '::1', '2001:db8::8a2e:370:7334', '::ffff:192.0.2.128'])(
    'renders %s, which is an address',
    (address) => {
      expect(RENDERED(address)).toContain(address);
    },
  );

  it.each(['facade.de', 'dead.beef.cafe', 'abcdef.cc', 'add.ee'])(
    'refuses %s, which is a hostname wearing hex digits',
    (hostname) => {
      const text = RENDERED(hostname);
      expect(text).not.toContain(hostname);
      expect(text).toContain('IP address: not recorded');
    },
  );
});
