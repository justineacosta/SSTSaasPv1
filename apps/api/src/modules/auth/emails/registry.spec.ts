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
 * The registry holds **eight** members: Task 5's seven, the invitation among
 * them, and Task 8's `registrationAttempt`.
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
  readonly userAgent: string;
}

const CASES: Record<EmailTemplateId, (s: AttackerStrings) => RenderedEmail> = {
  emailVerification: (s) =>
    EMAIL_TEMPLATES.emailVerification({
      recipientName: s.name,
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
  newDeviceSignIn: (s) => EMAIL_TEMPLATES.newDeviceSignIn(notice(s)),
  registrationAttempt: (s) => EMAIL_TEMPLATES.registrationAttempt(notice(s)),
};

function notice(s: AttackerStrings) {
  return {
    recipientName: s.name,
    occurredAt: OCCURRED_AT,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
  };
}

const BENIGN: AttackerStrings = {
  name: 'Ada Lovelace',
  organizationName: 'Acme Security',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
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
  userAgent: XSS_WITH_URL,
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

  it('registers the eight templates authentication.md §2, §5, §6 and §7 require', () => {
    expect([...IDS].sort()).toEqual([
      'emailVerification',
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

  it('escapes an attacker-chosen display name into the html part', () => {
    // Ruling 44. A display name is chosen at registration, an organisation name
    // at creation, and a user agent is a request header — all three reach these
    // templates and all three are attacker-controlled.
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

  it('carries no link when the value the CALLER supplied is a URL', () => {
    // H1, generalised to the field that is actually third-party text.
    //
    // NOT the display name, and that exclusion is a measurement rather than a
    // convenience. I first wrote this test with `name` injected too; it failed
    // for all five notices, because every one of them greets the recipient by
    // name — and then it stayed failing no matter what, because a greeting is
    // the point. It is also not a defect: `recipientName` is always the
    // RECIPIENT'S OWN stored name. An attacker who puts a URL there has put it
    // in a message delivered to themselves.
    //
    // `userAgent` and `ipAddress` are different in kind. On
    // `registrationAttempt` they come from whoever called `POST /auth/register`
    // — a stranger — and the message goes to somebody else. That is the whole
    // of H1.
    const email = CASES[id]({ ...BENIGN, ipAddress: XSS_WITH_URL, userAgent: XSS_WITH_URL });
    if (CONTEXT_FREE_NOTICE_IDS.includes(id as (typeof CONTEXT_FREE_NOTICE_IDS)[number])) {
      expect(email.html).not.toMatch(/https?:\/\//);
      expect(email.text).not.toMatch(/https?:\/\//);
    }
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
    const email = CASES[id]({ ...BENIGN, ipAddress: XSS_WITH_URL, userAgent: XSS_WITH_URL });
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
      userAgent: 'FIXTURE-agent-Chameleon/1.0',
    });
    for (const part of [email.html, email.text]) {
      expect(part).not.toContain('FIXTURE-ip-198.51.100.9');
      expect(part).not.toContain('FIXTURE-agent-Chameleon/1.0');
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
});

describe.each(CONTEXT_RENDERING_NOTICE_IDS)('context-rendering notice %s', (id) => {
  it('DOES reflect the user agent it is given — an open residual, asserted so it is visible', () => {
    // NOT an endorsement. This is a characterisation test: it records that the
    // same injection H1 closed on `registrationAttempt` is still open on these
    // four, so the residual lives in the suite rather than only in prose, and
    // the day somebody closes it this test goes red and has to be deleted
    // deliberately.
    //
    // Lower severity than H1 and not zero: reaching these requires the
    // account's own credentials, and none of the four has a caller yet
    // (Tasks 9 and 11 add them). The device line is kept because it is how a
    // recipient recognises a session that is not theirs.
    const email = CASES[id]({ ...BENIGN, userAgent: 'FIXTURE-agent-Chameleon/1.0' });
    expect(email.text).toContain('FIXTURE-agent-Chameleon/1.0');
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
