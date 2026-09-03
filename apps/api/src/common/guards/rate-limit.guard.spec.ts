import { describe, expect, it } from 'vitest';
import {
  normaliseAccountIdentifier,
  normaliseIp,
  RateLimitGuard,
  resolveIdentifier,
  TenantRateLimitGuard,
} from './rate-limit.guard.js';
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_SCOPE_PHASES,
  RATE_LIMIT_SCOPES,
} from './rate-limit.config.js';

describe('normaliseIp', () => {
  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // Two spellings of one client must be one bucket. They start arriving
    // together the moment `trust proxy` is enabled and forwarded addresses show
    // up in plain v4 form alongside directly-connected mapped-v6 ones.
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp('::ffff:127.0.0.1')).toBe(normaliseIp('127.0.0.1'));
    expect(normaliseIp('::FFFF:10.0.0.7')).toBe('10.0.0.7');
  });

  it('reduces a genuine IPv6 address to its /64, case-insensitively', () => {
    expect(normaliseIp('2001:DB8::1')).toBe(normaliseIp('2001:db8::1'));
    expect(normaliseIp('2001:DB8::1')).toContain('/64');
  });

  it('does not mistake an address that merely contains the mapped prefix', () => {
    // `::ffff:1.2.3.4` is a mapped IPv4 address; `2001:db8::ffff:1.2.3.4` is
    // not, and must not collapse to the bare v4 bucket.
    expect(normaliseIp('2001:db8::ffff:1.2.3.4')).not.toBe('1.2.3.4');
    expect(normaliseIp('2001:db8::ffff:1.2.3.4')).toContain('/64');
  });
});

describe('resolveIdentifier', () => {
  const login = RATE_LIMIT_CLASSES.login;

  it('normalises the IP it returns, not merely the helper in isolation', () => {
    // `normaliseIp` had a unit test and no caller test, so deleting the call
    // site left the suite green. This asserts the wiring.
    expect(resolveIdentifier('perIp', { ip: '::ffff:10.0.0.7' }, login)).toBe('10.0.0.7');
  });

  it('falls back to the socket address when Express has no view of the IP', () => {
    expect(resolveIdentifier('perIp', { socket: { remoteAddress: '10.0.0.9' } }, login)).toBe(
      '10.0.0.9',
    );
  });

  it('reads the account from the body for a body-keyed class, hashed', () => {
    const resolved = resolveIdentifier('perPrincipal', { body: { email: 'a@example.com' } }, login);
    expect(resolved).toBeDefined();
    expect(resolved).not.toContain('a@example.com');
    expect(resolved).not.toContain('@');
  });

  it('gives the same bucket for the same account written differently', () => {
    const shapes = ['a@example.com', 'A@Example.COM', '  a@example.com  '];
    const resolved = shapes.map((email) =>
      resolveIdentifier('perPrincipal', { body: { email } }, login),
    );
    expect(new Set(resolved).size).toBe(1);
  });

  it('gives different buckets for different accounts', () => {
    const a = resolveIdentifier('perPrincipal', { body: { email: 'a@example.com' } }, login);
    const b = resolveIdentifier('perPrincipal', { body: { email: 'b@example.com' } }, login);
    expect(a).not.toBe(b);
  });

  it('resolves nothing rather than sharing one bucket for every malformed body', () => {
    // A shared "undefined" bucket would be worse than no limit: every caller
    // with a malformed body would exhaust one window and lock out the rest.
    const login_ = login;
    for (const body of [
      undefined,
      null,
      'text',
      [],
      { email: 42 },
      { email: null },
      { email: [] },
      { email: '   ' },
      {},
    ]) {
      expect(
        resolveIdentifier('perPrincipal', { body }, login_),
        JSON.stringify(body),
      ).toBeUndefined();
    }
  });

  it('reads the authenticated principal for an authenticated class', () => {
    expect(
      resolveIdentifier(
        'perPrincipal',
        { principalId: 'usr_1', body: { email: 'attacker@example.com' } },
        RATE_LIMIT_CLASSES.generalSession,
      ),
    ).toBe('usr_1');
  });
});

describe('normaliseAccountIdentifier', () => {
  it('folds the same address written in NFC and NFD into one bucket', () => {
    const nfc = 'caf\u00e9@example.com';
    const nfd = 'cafe\u0301@example.com';
    expect(nfc).not.toBe(nfd);
    expect(normaliseAccountIdentifier(nfc)).toBe(normaliseAccountIdentifier(nfd));
  });

  it('is stable, so a restart does not hand everyone a fresh window', () => {
    expect(normaliseAccountIdentifier('A@Example.com')).toBe('a@example.com');
  });
});

describe('the account bucket digest', () => {
  it('is pinned: same input, same bucket, in every process and every instance', () => {
    // A per-process or per-instance salt would split one account's window
    // across instances and multiply the effective limit by the instance count —
    // a security defect dressed as hardening, and invisible to a test that only
    // checks stability within one process. Pinning the digest catches it, and
    // catches a truncation that would make collisions likely at the same time.
    const bucket = resolveIdentifier(
      'perPrincipal',
      { body: { email: 'pinned@example.com' } },
      RATE_LIMIT_CLASSES.login,
    );
    expect(bucket).toBe('drEi8prkvL9JOKpp7hx2HW');
  });

  it('keeps enough width that unrelated accounts do not share a window', () => {
    // Two accounts colliding means one is limited by the other's traffic — a
    // lockout the victim cannot see or avoid.
    const bucket = resolveIdentifier(
      'perPrincipal',
      { body: { email: 'width@example.com' } },
      RATE_LIMIT_CLASSES.login,
    );
    expect(bucket?.length).toBeGreaterThanOrEqual(22);
  });
});

describe('normaliseIp — IPv6 is bucketed by /64', () => {
  it('puts every address in one /64 into one bucket', () => {
    // A host is routinely delegated a whole /64 — 1.8e19 addresses. Bucketing
    // per address would make every per-IP figure in the table free to bypass
    // for anyone with a v6 allocation, which is the bound the resend class now
    // depends on.
    const a = normaliseIp('2001:db8:abcd:1234::1');
    const b = normaliseIp('2001:db8:abcd:1234::2');
    const c = normaliseIp('2001:db8:abcd:1234:dead:beef:1:2');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps different /64s apart', () => {
    expect(normaliseIp('2001:db8:abcd:1234::1')).not.toBe(normaliseIp('2001:db8:abcd:1235::1'));
    expect(normaliseIp('2001:db8:abcd:1234::1')).not.toBe(normaliseIp('2001:db9:abcd:1234::1'));
  });

  it('expands :: correctly rather than truncating the wrong hextets', () => {
    // `2001:db8::1` is 2001:0db8:0000:0000:...:0001, so its /64 must be
    // 2001:db8:0:0 — not 2001:db8:1 read off the literal text.
    expect(normaliseIp('2001:db8::1')).toBe(normaliseIp('2001:db8:0:0:ffff::9'));
    expect(normaliseIp('2001:db8::1')).not.toBe(normaliseIp('2001:db8:1::1'));
  });

  it('still treats loopback and mapped IPv4 the way the rest of the suite expects', () => {
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp('127.0.0.1')).toBe('127.0.0.1');
    // Not `toBe(normaliseIp('::1'))` — comparing a call to itself is a
    // tautology that passes no matter what the function does. Pin the shape.
    expect(normaliseIp('::1')).toBe('0:0:0:0::/64');
  });

  it('buckets a zone-bearing address with its zoneless twin', () => {
    // A zone index is host-local and not part of identity. This holds because
    // the zone attaches to the LAST hextet and the /64 keeps the first four —
    // it is a property of the bucketing, not of a strip somewhere. The old
    // version compared two zoned addresses to each other, which passed with
    // the strip deleted; this compares against the zoneless form and against
    // the key, so it constrains the outcome that matters.
    expect(normaliseIp('fe80::1%eth0')).toBe(normaliseIp('fe80::1'));
    expect(normaliseIp('fe80::1%eth0')).not.toContain('%');
  });
});

describe('normaliseAccountIdentifier — the form is pinned, not just its presence', () => {
  it('applies NFKC, not merely NFC', () => {
    // The docblock says this must stay identical to the Phase 2 account lookup.
    // Which normalisation form it *is* was the one thing no test pinned, so
    // switching NFKC to NFC changed behaviour silently. Fullwidth and ligature
    // forms fold under NFKC and survive under NFC.
    expect(normaliseAccountIdentifier('\uff41@example.com')).toBe('a@example.com');
    expect(normaliseAccountIdentifier('\ufb01n@example.com')).toBe('fin@example.com');
  });

  it('does not merge characters that are genuinely distinct letters', () => {
    // NFKC is aggressive; this is the boundary worth pinning, because an
    // over-merge lets one account consume another's window.
    expect(normaliseAccountIdentifier('\u0131@example.com')).not.toBe('i@example.com');
    expect(normaliseAccountIdentifier('a\u200bb@example.com')).not.toBe('ab@example.com');
  });
});

describe('the unresolvable-scope warning is suppressed per scope, not per class', () => {
  /** Drives the guard directly: a real socket always has a peer address, so the
   *  per-IP scope cannot be made unresolvable over HTTP — but a wiring defect
   *  can, which is the case this warning exists for. */
  function harness() {
    const warned: string[][] = [];
    const logger = {
      warn: (bindings: { unresolvedScopes?: string[] }) => {
        if (bindings.unresolvedScopes !== undefined) warned.push(bindings.unresolvedScopes);
      },
      debug: () => undefined,
    };
    const reflector = {
      get: () => undefined,
      getAllAndOverride: (key: string) => (key === 'sentinel:rate-limit' ? 'login' : undefined),
    };
    // One allowed decision, so the guard reaches the reporting branch.
    const redis = { eval: () => Promise.resolve([1, 1, '-1']) };
    const guard = new RateLimitGuard(reflector as never, redis as never, logger as never);

    const run = (request: Record<string, unknown>): Promise<boolean> =>
      guard.canActivate({
        getType: () => 'http',
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ setHeader: () => undefined }),
        }),
      } as never);

    return { run, warned };
  }

  it('reports a second scope even after the first has been reported', async () => {
    // Keyed by class alone, the first miss burns the class's only warning — and
    // on `login` that first miss is free for any unauthenticated caller to
    // trigger by posting a body with no `email`, within seconds of boot. A
    // genuine wiring defect on the other scope would then never be reported for
    // the life of the process, which is the opposite of the point.
    const { run, warned } = harness();

    await run({ ip: '203.0.113.1', body: {} }); // perPrincipal unresolvable
    await run({ body: { email: 'a@example.com' } }); // perIp unresolvable

    expect(warned.flat()).toContain('perPrincipal');
    expect(warned.flat()).toContain('perIp');
  });

  it('still does not repeat a scope it has already reported', async () => {
    const { run, warned } = harness();

    for (let i = 0; i < 5; i += 1) await run({ ip: '203.0.113.1', body: {} });

    expect(warned.flat().filter((scope) => scope === 'perPrincipal')).toHaveLength(1);
  });
});

/**
 * THE TWO-PHASE SPLIT, WHICH IS WHAT MAKES `perOrganization` REACHABLE AT ALL.
 *
 * Task 15. Before it, `RATE_LIMIT_SCOPE_PHASES` did not exist and the limiter
 * ran once, before authentication — so a fail-closed class whose only scope is
 * `perOrganization` refused **every** request with 429, which
 * `rate-limit.integration.spec.ts` asserts against `@RateLimit('invitations')`
 * on a fixture route and has done since Phase 1.
 *
 * Each test below names the mutation it fails under, because a phase filter is
 * the kind of change whose two halves each look harmless alone: dropping the
 * early return makes the edge pass refuse every invitation; dropping the filter
 * makes both passes charge every window twice.
 */
describe('the limiter runs in two phases and each scope belongs to exactly one', () => {
  /** Every command the guard actually issued, so double-charging is visible. */
  function phaseHarness(className: string) {
    const keys: string[] = [];
    const logger = { warn: () => undefined, debug: () => undefined };
    const reflector = {
      get: () => undefined,
      getAllAndOverride: (key: string) => (key === 'sentinel:rate-limit' ? className : undefined),
    };
    const redis = {
      eval: (_script: unknown, _numKeys: unknown, key: string) => {
        keys.push(key);
        return Promise.resolve([1, 1, '-1']);
      },
    };
    const edge = new RateLimitGuard(reflector as never, redis as never, logger as never);
    const tenant = new TenantRateLimitGuard(reflector as never, redis as never, logger as never);

    const run = (guard: RateLimitGuard, request: Record<string, unknown>): Promise<boolean> =>
      guard.canActivate({
        getType: () => 'http',
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ setHeader: () => undefined }),
        }),
      } as never);

    return { edge, tenant, run, keys };
  }

  it('partitions every scope between the two phases, with none in both and none in neither', () => {
    // The table is the whole of the difference between the two passes, so the
    // partition is the property to pin rather than the individual assignments.
    // A scope in both phases is a window charged twice per request; a scope in
    // neither is a limit that silently stops applying.
    for (const scope of RATE_LIMIT_SCOPES) {
      expect(['edge', 'tenant']).toContain(RATE_LIMIT_SCOPE_PHASES[scope]);
    }
    expect(Object.keys(RATE_LIMIT_SCOPE_PHASES).sort()).toEqual([...RATE_LIMIT_SCOPES].sort());
    expect(RATE_LIMIT_SCOPE_PHASES.perOrganization).toBe('tenant');
  });

  it('lets a fail-CLOSED per-organisation class through the edge pass untouched', async () => {
    // The mutation this fails under is deleting the phase filter, which makes
    // the edge pass see one declared scope, resolve nothing, and apply the fail
    // mode — 429 on every request to the only route that carries this class,
    // which is what the API did before this split existed.
    //
    // It does NOT fail under deleting an early `return true` for a phase with
    // no declared scope: that guard was written here first, measured
    // redundant (29/29 still green without it) and removed. The line that
    // carries the property is `declared` counting this phase's scopes only.
    const { edge, run, keys } = phaseHarness('invitations');
    await expect(run(edge, { ip: '203.0.113.1' })).resolves.toBe(true);
    // And it reached Redis for nothing, which is the second half of "this pass
    // has nothing to say".
    expect(keys).toEqual([]);
  });

  it('still refuses in the TENANT pass when the organisation cannot be resolved', async () => {
    // The fail-closed promise is not weakened, only moved to the stage that can
    // keep it. An unauthenticated request reaches this pass with no
    // `organizationId` — every declared scope unresolvable, so 429.
    const { tenant, run } = phaseHarness('invitations');
    await expect(run(tenant, { ip: '203.0.113.1' })).rejects.toMatchObject({ status: 429 });
  });

  it('charges the per-organisation window in the tenant pass once the tenant is resolved', async () => {
    const { tenant, run, keys } = phaseHarness('invitations');
    await expect(run(tenant, { ip: '203.0.113.1', organizationId: 'org_1' })).resolves.toBe(true);
    expect(keys).toEqual(['ratelimit:invitations:perOrganization:org_1']);
  });

  it('does not charge a per-IP window twice across the two passes', async () => {
    // The mutation this fails under is deleting the phase filter from the loop.
    // Both passes would then evaluate `perIp`, so `registration`'s 3/hour would
    // become 1.5/hour and every figure in `abuse-prevention.md` §1 would be
    // half what the document says.
    const { edge, tenant, run, keys } = phaseHarness('registration');
    await run(edge, { ip: '203.0.113.1' });
    await run(tenant, { ip: '203.0.113.1' });
    expect(keys).toEqual(['ratelimit:registration:perIp:203.0.113.1']);
  });

  it('lets a class with no tenant-phase scope through the tenant pass without a command', async () => {
    // The other direction of the same partition: `generalSession` is
    // `perPrincipal` only, so the tenant pass must issue nothing and refuse
    // nothing — including for a request that resolved an organisation.
    const { tenant, run, keys } = phaseHarness('generalSession');
    await expect(
      run(tenant, { ip: '203.0.113.1', principalId: 'usr_1', organizationId: 'org_1' }),
    ).resolves.toBe(true);
    expect(keys).toEqual([]);
  });
});
