import { describe, expect, it } from 'vitest';
import {
  API_KEY_PRINCIPAL_NOT_IMPLEMENTED,
  assertUserPrincipal,
  isUserPrincipal,
  type ApiKeyPrincipal,
  type Principal,
  type UserPrincipal,
} from './principal.js';

const userPrincipal: UserPrincipal = {
  kind: 'user',
  userId: 'usr_01M0T74WZZFY9T2QS56RGF3GQ7',
  sessionId: 'ses_01M0T74WZZFY9T2QS56RGF3GQ8',
};

const apiKeyPrincipal: ApiKeyPrincipal = {
  kind: 'apiKey',
  keyId: 'key_01M0T74WZZFY9T2QS56RGF3GQ9',
  organizationId: 'org_01M0T74WZZFY9T2QS56RGF3GQA',
  permissions: ['finding.read'],
};

describe('isUserPrincipal', () => {
  it('narrows the user arm', () => {
    const principal: Principal = userPrincipal;
    expect(isUserPrincipal(principal)).toBe(true);
    if (isUserPrincipal(principal)) {
      // Reached only if the type guard narrows; `sessionId` does not exist on
      // the union.
      expect(principal.sessionId).toBe(userPrincipal.sessionId);
    }
  });

  it('rejects the apiKey arm', () => {
    expect(isUserPrincipal(apiKeyPrincipal)).toBe(false);
  });
});

describe('assertUserPrincipal', () => {
  it('returns the principal unchanged for the user arm', () => {
    expect(assertUserPrincipal(userPrincipal)).toBe(userPrincipal);
  });

  it('throws for the apiKey arm rather than silently allowing it', () => {
    // The whole point of the arm existing before it is implemented is that
    // code reaching it FAILS. A guard that quietly treated an unimplemented
    // API-key principal as authorised would be the worst possible outcome of
    // defining the type early.
    expect(() => assertUserPrincipal(apiKeyPrincipal)).toThrow(API_KEY_PRINCIPAL_NOT_IMPLEMENTED);
    expect(API_KEY_PRINCIPAL_NOT_IMPLEMENTED).toContain(
      'API key principals are not implemented in Phase 2',
    );
  });
});

describe('the Principal union', () => {
  it('is exhaustive — a new arm must break this switch, not slip through it', () => {
    const describeKind = (principal: Principal): string => {
      switch (principal.kind) {
        case 'user':
          return 'user';
        case 'apiKey':
          return 'apiKey';
        default: {
          // A third arm added to the union without a case here is a compile
          // error on this line, which is the assertion. It is a `never`
          // check, so it costs nothing at runtime.
          const unhandled: never = principal;
          return String(unhandled);
        }
      }
    };

    expect(describeKind(userPrincipal)).toBe('user');
    expect(describeKind(apiKeyPrincipal)).toBe('apiKey');
  });

  it('discriminates on `kind` alone, with no overlapping field set', () => {
    // Two arms that could be told apart only by looking for the presence of a
    // field would make every downstream guard a duck-type check.
    expect(Object.keys(userPrincipal).sort()).toEqual(['kind', 'sessionId', 'userId']);
    expect(Object.keys(apiKeyPrincipal).sort()).toEqual([
      'keyId',
      'kind',
      'organizationId',
      'permissions',
    ]);
  });
});
