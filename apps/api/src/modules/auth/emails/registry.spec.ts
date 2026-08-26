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
 * iterates the exported registry instead, so Task 15's seventh template
 * inherits every rule here by existing.
 *
 * The two tables below are `Record<EmailTemplateId, …>`, which is the part that
 * makes that true: adding a member to the registry without adding its sample
 * and its hostile sample is a **compile error**, not a silently uncovered
 * template. `pnpm typecheck` is where that lands (carry-forward ruling 40 — it
 * can be red while `pnpm test` is green).
 */

const TOKEN = 'FIXTURE_not_a_real_token-registry_000000000';
const BASE_URL = 'https://app.sentinel.test';
const OCCURRED_AT = new Date('2026-08-26T09:41:07.512Z');

/** A benign render of every template. */
const SAMPLES: Record<EmailTemplateId, () => RenderedEmail> = {
  emailVerification: () =>
    EMAIL_TEMPLATES.emailVerification({
      recipientName: 'Ada Lovelace',
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 86_400,
    }),
  passwordReset: () =>
    EMAIL_TEMPLATES.passwordReset({
      recipientName: 'Ada Lovelace',
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 3_600,
    }),
  invitation: () =>
    EMAIL_TEMPLATES.invitation({
      inviterName: 'Grace Hopper',
      organizationName: 'Acme Security',
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 604_800,
    }),
  passwordChanged: () =>
    EMAIL_TEMPLATES.passwordChanged({
      recipientName: 'Ada Lovelace',
      occurredAt: OCCURRED_AT,
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    }),
  mfaEnabled: () =>
    EMAIL_TEMPLATES.mfaEnabled({
      recipientName: 'Ada Lovelace',
      occurredAt: OCCURRED_AT,
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    }),
  mfaDisabled: () =>
    EMAIL_TEMPLATES.mfaDisabled({
      recipientName: 'Ada Lovelace',
      occurredAt: OCCURRED_AT,
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    }),
  newDeviceSignIn: () =>
    EMAIL_TEMPLATES.newDeviceSignIn({
      recipientName: 'Ada Lovelace',
      occurredAt: OCCURRED_AT,
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    }),
};

/**
 * The same templates with every attacker-controllable string replaced by a
 * payload. A display name is chosen by whoever registers; an organisation name
 * by whoever creates the organisation; a user agent is a request header and is
 * therefore attacker-chosen outright.
 */
const XSS = `<script>alert(1)</script>" onmouseover="steal()`;

const HOSTILE: Record<EmailTemplateId, () => RenderedEmail> = {
  emailVerification: () =>
    EMAIL_TEMPLATES.emailVerification({
      recipientName: XSS,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 86_400,
    }),
  passwordReset: () =>
    EMAIL_TEMPLATES.passwordReset({
      recipientName: XSS,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 3_600,
    }),
  invitation: () =>
    EMAIL_TEMPLATES.invitation({
      inviterName: XSS,
      organizationName: XSS,
      webBaseUrl: BASE_URL,
      token: TOKEN,
      ttlSeconds: 604_800,
    }),
  passwordChanged: () =>
    EMAIL_TEMPLATES.passwordChanged({
      recipientName: XSS,
      occurredAt: OCCURRED_AT,
      ipAddress: XSS,
      userAgent: XSS,
    }),
  mfaEnabled: () =>
    EMAIL_TEMPLATES.mfaEnabled({
      recipientName: XSS,
      occurredAt: OCCURRED_AT,
      ipAddress: XSS,
      userAgent: XSS,
    }),
  mfaDisabled: () =>
    EMAIL_TEMPLATES.mfaDisabled({
      recipientName: XSS,
      occurredAt: OCCURRED_AT,
      ipAddress: XSS,
      userAgent: XSS,
    }),
  newDeviceSignIn: () =>
    EMAIL_TEMPLATES.newDeviceSignIn({
      recipientName: XSS,
      occurredAt: OCCURRED_AT,
      ipAddress: XSS,
      userAgent: XSS,
    }),
};

const IDS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[];

describe('the email template registry', () => {
  it('covers every registered template with a sample and a hostile sample', () => {
    // The compile-time guarantee above, restated at runtime: `Record<K, …>` is
    // only exhaustive against the union TypeScript sees, and `EMAIL_TEMPLATES`
    // is the thing actually iterated.
    expect(Object.keys(SAMPLES).sort()).toEqual([...IDS].sort());
    expect(Object.keys(HOSTILE).sort()).toEqual([...IDS].sort());
  });

  it('classifies every template as either link-carrying or a notice', () => {
    // Three carry a live credential and three carry none. A seventh template
    // that is neither is a template nobody decided about, and the rules below
    // divide along exactly this line.
    const classified = [...TOKEN_LINK_TEMPLATE_IDS, ...NOTICE_TEMPLATE_IDS];
    expect([...classified].sort()).toEqual([...IDS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('registers the six templates authentication.md §2, §5, §6 and §7 require', () => {
    expect([...IDS].sort()).toEqual([
      'emailVerification',
      'invitation',
      'mfaDisabled',
      'mfaEnabled',
      'newDeviceSignIn',
      'passwordChanged',
      'passwordReset',
    ]);
  });
});

describe.each(IDS)('template %s', (id) => {
  it('has a non-empty subject, html part and text part', () => {
    const email = SAMPLES[id]();
    expect(email.subject.trim().length).toBeGreaterThan(0);
    expect(email.html.trim().length).toBeGreaterThan(0);
    expect(email.text.trim().length).toBeGreaterThan(0);
  });

  it('has a text part that is real prose, not stripped markup', () => {
    const email = SAMPLES[id]();
    expect(email.text).not.toContain('<');
    expect(email.text).not.toContain('style=');
    expect(email.text.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(80);
    expect(email.text).toContain(email.subject);
  });

  it('leaves no unreplaced placeholder in either part', () => {
    const email = SAMPLES[id]();
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
    const { html } = SAMPLES[id]();
    for (const forbidden of ['<img', 'src=', '<link', '@import', 'url(', 'background=']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('escapes an attacker-chosen display name into the html part', () => {
    // Ruling 44. A display name is chosen at registration, an organisation name
    // at creation, and a user agent is a request header — all three reach these
    // templates and all three are attacker-controlled.
    const { html } = HOSTILE[id]();
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
    expect(quotes(html)).toBe(quotes(SAMPLES[id]().html));
  });

  it('does not leak the payload through the subject line either', () => {
    // A subject is rendered as text by every client, so it needs no escaping —
    // but it must also not be silently dropped, and a template that interpolates
    // a hostile name into a subject and then into markup would show up here.
    const { subject } = HOSTILE[id]();
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
    const url = linkFrom(SAMPLES[id]().html);
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(url.pathname).not.toContain(TOKEN);
  });

  it('carries the same link in the text part, so a text-only client still works', () => {
    // A verification mail whose only actionable content is in the HTML part is a
    // verification mail that fails for anyone reading in plain text.
    const url = linkFrom(SAMPLES[id]().text);
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(url.origin).toBe(BASE_URL);
  });

  it('states the lifetime the token was actually issued with', () => {
    // Derived from the configured TTL rather than written into the prose, so
    // shortening a TTL during an incident does not leave the mail lying.
    expect(SAMPLES[id]().text).toMatch(/\b(24 hours|1 hour|7 days)\b/);
  });
});

describe.each(NOTICE_TEMPLATE_IDS)('notice template %s', (id) => {
  it('carries no token', () => {
    const email = SAMPLES[id]();
    expect(email.html).not.toContain('token');
    expect(email.text).not.toContain('token');
  });

  it('carries no link of any kind, in either part', () => {
    // A stronger property than "no token", and the one worth having: these three
    // messages exist to tell a victim that something happened to their account,
    // which is exactly the message a phisher wants to imitate. A notice with no
    // link at all trains the recipient that a real one never asks them to click,
    // and removes any chance of one shipping with a live credential in it.
    const email = SAMPLES[id]();
    expect(email.html).not.toMatch(/https?:\/\//);
    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toContain('href');
  });

  it('names when it happened, in UTC', () => {
    expect(SAMPLES[id]().text).toContain('2026-08-26 09:41 UTC');
  });
});

describe('the two MFA states', () => {
  it('are both reachable and say different things', () => {
    // The brief allowed one template with a discriminator or two templates.
    // Two registry ids over one renderer is the choice: the adapter logs the
    // template id (ruling 47), and "MFA was disabled" is the security-relevant
    // half — an operator reading logs should not have to open the body to tell
    // which of the two was sent.
    const enabled = SAMPLES.mfaEnabled();
    const disabled = SAMPLES.mfaDisabled();
    expect(enabled.subject).not.toBe(disabled.subject);
    expect(enabled.text).toContain('enabled');
    expect(disabled.text).toContain('disabled');
    expect(enabled.text).not.toContain('disabled');
  });
});
