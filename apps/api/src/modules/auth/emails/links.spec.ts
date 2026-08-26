import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTokenLink, TOKEN_LINK_PATHS, type TokenLinkKind } from './links.js';

/**
 * A HOST-HEADER-DERIVED RESET LINK IS AN ACCOUNT-TAKEOVER PRIMITIVE.
 *
 * Ruling 42. The attack is old and still works: the attacker POSTs the victim's
 * address to `/auth/forgot-password` with `Host: attacker.test`, the application
 * builds the link from the request it happens to have in scope, and the victim
 * receives a genuine reset mail from a genuine sender whose link hands the token
 * to the attacker. The mail is real, so no spam filter and no user is going to
 * catch it.
 *
 * The way that helper gets written is never malice; it is a function with a
 * request already in scope taking the convenient value. So the requirement here
 * is not "should not read the Host header" but *cannot*: `buildTokenLink` takes
 * three primitives and there is no fourth parameter for a request to arrive
 * through. The last test in this file asserts that structurally, against the
 * source, because a type signature is only load-bearing until someone widens it.
 */

const BASE = 'https://app.sentinel.test';
/**
 * A deliberately LOW-ENTROPY fixture, and that is the point.
 *
 * It keeps a real token's shape — 43 characters of base64url, including the
 * `_` and `-` that must survive URL construction — while being unmistakably
 * fake to a human and to a secret scanner. The previous value here was random
 * base64url, indistinguishable from a live credential, and GitGuardian flagged
 * this file and `registry.spec.ts` as the two uncovered secrets on PR #10.
 *
 * Same lesson as ruling 57 one layer over: a credential-shaped string in a
 * committed file costs something even when it is inert. There it was a real
 * token in a ledger and cost a history rewrite; here it is a fixture that was
 * never a credential at all, and it still turned a security product's own
 * security check red. **A test fixture standing in for a secret should look
 * like a fixture.**
 */
const TOKEN = 'FIXTURE_not_a_real_token-links_000000000000';
const KINDS = Object.keys(TOKEN_LINK_PATHS) as TokenLinkKind[];

describe('buildTokenLink', () => {
  it('puts the secret in a ?token= query parameter', () => {
    // Ruling 41, standing on carry-forward rulings 34 and 36: `token` is the
    // ONE parameter name the redacting logger's value-shape pattern still
    // matches. `key` and `code` were removed from that list in Task 4, and a
    // path segment (`/verify/<token>`) was measured leaking verbatim.
    const url = new URL(buildTokenLink(BASE, 'emailVerification', TOKEN));
    expect(url.searchParams.get('token')).toBe(TOKEN);
  });

  it.each(KINDS)('puts the secret in a query parameter for %s, never a path segment', (kind) => {
    const url = new URL(buildTokenLink(BASE, kind, TOKEN));
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(url.pathname).not.toContain(TOKEN);
  });

  it.each(KINDS)('keeps the origin of the configured base URL for %s', (kind) => {
    expect(new URL(buildTokenLink(BASE, kind, TOKEN)).origin).toBe(new URL(BASE).origin);
  });

  it('preserves a base URL that is mounted under a path prefix', () => {
    const url = new URL(buildTokenLink('https://sentinel.test/app', 'passwordReset', TOKEN));
    expect(url.origin).toBe('https://sentinel.test');
    expect(url.pathname).toBe('/app/reset-password');
  });

  it('does not double the separator when the base URL has a trailing slash', () => {
    const url = new URL(buildTokenLink('https://sentinel.test/', 'passwordReset', TOKEN));
    expect(url.pathname).toBe('/reset-password');
  });

  it('discards a query string or fragment already on the base URL', () => {
    // A base carrying `?next=` would otherwise survive into the link and give a
    // second, attacker-influenceable parameter to the page that reads the token.
    const url = new URL(
      buildTokenLink('https://sentinel.test/?next=//evil.test#frag', 'invitation', TOKEN),
    );
    expect(url.search).toBe(`?token=${TOKEN}`);
    expect(url.hash).toBe('');
  });

  it('cannot be steered to another origin by the token argument', () => {
    // The token is a minted base64url string in production, but the argument is
    // still an untyped `string` and this is the parameter closest to an
    // attacker. Every one of these is inert because it is set through
    // `searchParams`, which percent-encodes rather than reinterprets.
    const hostile = [
      'https://evil.test/steal',
      '//evil.test',
      '../../evil',
      'x#@evil.test',
      'x?redirect=https://evil.test',
      'x&admin=true',
    ];
    for (const candidate of hostile) {
      const url = new URL(buildTokenLink(BASE, 'passwordReset', candidate));
      expect(url.origin).toBe('https://app.sentinel.test');
      expect(url.pathname).toBe('/reset-password');
      expect(url.searchParams.get('token')).toBe(candidate);
      expect([...url.searchParams.keys()]).toEqual(['token']);
    }
  });

  it('offers exactly three link kinds, so an arbitrary path cannot be requested', () => {
    // The path is chosen from a closed set rather than passed in. A caller that
    // could pass a path could pass `//evil.test`, and `new URL('//evil.test',
    // base)` resolves to a different origin entirely.
    expect(Object.keys(TOKEN_LINK_PATHS).sort()).toEqual([
      'emailVerification',
      'invitation',
      'passwordReset',
    ]);
  });

  it('takes three arguments and no more', () => {
    // Not decoration: the whole control is that there is no parameter a request
    // object could arrive through. Widening the signature fails here first.
    expect(buildTokenLink.length).toBe(3);
  });

  it('is written in a file that cannot see a request at all', () => {
    // The structural half of ruling 42. A signature holds only until someone
    // widens it; this holds until someone deletes the test, which is a visible
    // act. Reads the source rather than reasoning about it.
    const source = readFileSync(fileURLToPath(new URL('./links.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bimport\b/);
    for (const forbidden of ['request', 'Request', 'header', 'Header', 'host', 'Host', 'origin']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
