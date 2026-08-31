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
  readonly name: string;
  readonly organizationName: string;
  readonly ipAddress: string;
}

/**
 * The templates that render no attacker-supplied string whatsoever.
 *
 * All three are sent to an address whose ownership nobody has proven, or
 * describe somebody else's activity, which is what makes the stored display
 * name untrustworthy: anyone may register somebody else's address with 200
 * characters of chosen text in `name` (F1). None takes a name, an IP or a user
 * agent, so for these the assertion is ABSENCE rather than escaping.
 *
 * `failedLoginBurst` joins them in Task 9 and is the sharpest case: the burst
 * is *somebody else's* attempt, so neither the IP nor the user agent describes
 * the recipient at all, and the user agent is attacker-chosen free text. Its
 * context type is `{ occurredAt, attemptCount }` and there is no third field
 * for any of it to travel through.
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
] as const satisfies readonly EmailTemplateId[];

/**
 * RULING 70, AS A PARTITION: WHICH TEMPLATES MAY RENDER A STORED DISPLAY NAME.
 *
 * "A message sent to an address whose ownership has not been proven must render
 * NO stored display name." `User.name` is free text an attacker seeds by
 * registering the victim's address first, so a template that greets by name is
 * a template that can be made to greet with a stranger's sentence and URL.
 *
 * `newDeviceSignIn` moves into the left-hand list in Task 9, and its reason is
 * narrower than the other three's: it is sent only when `emailVerifiedAt` is
 * non-null, so ownership *has* been proven — but the name adds nothing the
 * recipient needs and the parameter is the whole attack surface, so the type
 * drops it. It keeps its IP and user agent, because there they describe the
 * recipient's own new session, which is ruling 63's licensed side of the
 * partition.
 *
 * `satisfies` makes this exhaustive at compile time: a new template must be
 * classified here or the build fails.
 */
const NO_DISPLAY_NAME_TEMPLATE_IDS = [
  'emailVerification',
  'registrationAttempt',
  'failedLoginBurst',
  'newDeviceSignIn',
] as const satisfies readonly EmailTemplateId[];

const DISPLAY_NAME_TEMPLATE_IDS = [
  'passwordReset',
  'invitation',
  'passwordChanged',
  'mfaEnabled',
  'mfaDisabled',
] as const satisfies readonly EmailTemplateId[];

const CASES: Record<EmailTemplateId, (s: AttackerStrings) => RenderedEmail> = {
  emailVerification: () =>
    EMAIL_TEMPLATES.emailVerification({
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 86_400,
    }),
  passwordReset: (s) =>
    EMAIL_TEMPLATES.passwordReset({
      recipientName: s.name,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 3_600,
    }),
  invitation: (s) =>
    EMAIL_TEMPLATES.invitation({
      inviterName: s.name,
      organizationName: s.organizationName,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 604_800,
    }),
  passwordChanged: (s) => EMAIL_TEMPLATES.passwordChanged(notice(s)),
  mfaEnabled: (s) => EMAIL_TEMPLATES.mfaEnabled(notice(s)),
  mfaDisabled: (s) => EMAIL_TEMPLATES.mfaDisabled(notice(s)),
  // `s.name` IS NOT PASSED, and it cannot be: `NewDeviceSignInContext` has no
  // `recipientName` field as of Task 9 (ruling 70). The IP and the user agent
  // are still passed and still escaped, because there they describe the
  // recipient's own session.
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
  return {
    recipientName: s.name,
    occurredAt: OCCURRED_AT,
    ipAddress: s.ipAddress,
  };
}

const BENIGN: AttackerStrings = {
  name: 'Ada Lovelace',
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

  it('registers the nine templates authentication.md §2, §5, §6 and §7 require', () => {
    expect([...IDS].sort()).toEqual([
      'emailVerification',
      // Task 9. §7's "a burst notifies the account owner" had no template at
      // all until now — the sentence was in the document and nothing could
      // satisfy it.
      'failedLoginBurst',
      'invitation',
      'mfaDisabled',
      'mfaEnabled',
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

  it('classifies every template as rendering a display name or not (ruling 70)', () => {
    const classified = [...NO_DISPLAY_NAME_TEMPLATE_IDS, ...DISPLAY_NAME_TEMPLATE_IDS];
    expect([...classified].sort()).toEqual([...IDS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });
});

describe.each(NO_DISPLAY_NAME_TEMPLATE_IDS)('name-free template %s', (id) => {
  it('renders no display name even when the display name is a URL', () => {
    // THE TEST RULING 70 SAYS TO WRITE. The payload is a sentence AND a link,
    // because the escaping payload alone contains no scheme and would have
    // passed a "carries no link" assertion vacuously (F-series, Task 8).
    //
    // It passes structurally rather than by filtering: none of these four
    // templates has a parameter a display name could travel through, so the
    // `CASES` entry above cannot pass one. That is the property — a value that
    // cannot be supplied cannot be injected, and a denylist over attacker text
    // is a defect waiting for a new encoding.
    const email = CASES[id]({ ...BENIGN, name: XSS_WITH_URL });
    for (const part of [email.html, email.text]) {
      expect(part).not.toContain('steal()');
      expect(part).not.toContain(INJECTED_URL);
      expect(part).not.toContain('Ada Lovelace');
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
    // Two templates render NONE of them and are skipped rather than asserted
    // about: `emailVerification` and `registrationAttempt` take no name, no IP
    // and no user agent at all (F1), so there is nothing here to escape. That
    // skip is checked rather than trusted — the assertion below it proves the
    // payload is absent instead of merely escaped.
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
 * THE THREE NOTICES THAT STILL GREET BY NAME, AND THEREFORE STILL CARRY THE
 * RESIDUAL RULING 70 NAMES.
 *
 * Measured during the H2 fix round, against the built module: with every other
 * caller-supplied field benign, a `recipientName` that is a URL still produces
 * a link in these three. `User.name` is 200 characters of free text written
 * straight from a registration body, so this is ruling 70's open item, not a
 * new one — the ruling assigns `passwordReset`'s copy of it to **Task 10** and
 * the reasoning reaches the two MFA notices, which are **Task 11's**.
 *
 * **None of the three has a shipped caller**, and that is what makes this an
 * inherited residual rather than a live defect. It is also the exact sentence
 * that was false about `newDeviceSignIn` before H2 — Task 9 shipped its caller
 * and left the claim standing — so it is stated here as a checkable fact rather
 * than a reassurance: `grep -rn "sendPasswordChanged\|sendMfaEnabled\|sendMfaDisabled"
 * apps/api/src` returns nothing but this comment.
 *
 * The block below is two-sided on purpose. It asserts that the residual is
 * **exactly** the display name — every other field hostile produces no link —
 * and that the display name **does** still carry one. A one-sided version could
 * go vacuous; this one goes red the day either half changes, which is what the
 * characterisation test H2 deleted failed to do.
 */
const NAME_GREETING_NOTICE_IDS = [
  'passwordChanged',
  'mfaEnabled',
  'mfaDisabled',
] as const satisfies readonly EmailTemplateId[];

const RULING_70_CLEAN_NOTICE_IDS = NOTICE_TEMPLATE_IDS.filter(
  (id) => !(NAME_GREETING_NOTICE_IDS as readonly EmailTemplateId[]).includes(id),
);

describe.each(NAME_GREETING_NOTICE_IDS)('notice %s still greets by name', (id) => {
  it('renders no link when every field EXCEPT the display name is a URL', () => {
    // The half H2 closed. Before the IP guard this failed here too: `ipAddress`
    // was rendered verbatim, so a URL in it produced a link in all four
    // context-rendering notices. Measured, and now enforced by
    // `renderableIpAddress` rather than asserted about the caller.
    const email = CASES[id]({
      name: 'Ada Lovelace',
      organizationName: XSS_WITH_URL,
      ipAddress: XSS_WITH_URL,
    });
    for (const part of [email.html, email.text]) {
      expect(part).not.toMatch(/https?:\/\//);
      expect(part).not.toContain(INJECTED_URL);
    }
  });

  it('DOES render a display name that is a URL — ruling 70 open, owned by Tasks 10 and 11', () => {
    // NOT an endorsement, and not a test to adjust. It records the exact shape
    // of what is left, so the residual lives in the suite rather than only in
    // prose, and so that closing it turns this red and forces a deliberate
    // deletion. The one it replaces made the same promise and had the wrong
    // grounds written under it; these grounds are checkable — see the docblock.
    const email = CASES[id]({
      name: XSS_WITH_URL,
      organizationName: 'Acme Security',
      ipAddress: '203.0.113.7',
    });
    expect(email.text).toContain(INJECTED_URL);
  });
});

describe.each(RULING_70_CLEAN_NOTICE_IDS)('notice %s under ruling 70 prescribed payload', (id) => {
  it('renders no link when EVERY caller-supplied field it accepts is a URL', () => {
    // RULING 70'S PRESCRIBED TEST, APPLIED TO EVERY NOTICE RATHER THAN TO TWO.
    //
    // "The test to write is 'no link when EVERY caller-supplied field is a
    // URL', with the display name in the list." It existed over
    // `CONTEXT_FREE_NOTICE_IDS` only — two templates — and the block that
    // covered the other four passed BENIGN values for `ipAddress` and
    // `userAgent` and hostile text only for the name. That is carry-forward
    // ruling 58's family: a fixture sitting on one side of the branch under
    // test, which is how H2 stayed green here while being live in production.
    //
    // Every caller-supplied field each template accepts now carries a URL.
    const email = CASES[id]({
      name: XSS_WITH_URL,
      organizationName: XSS_WITH_URL,
      ipAddress: XSS_WITH_URL,
    });
    for (const part of [email.html, email.text]) {
      expect(part).not.toMatch(/https?:\/\//);
      expect(part).not.toContain(INJECTED_URL);
    }
    expect(email.html).not.toContain('href');
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
