import { describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '@sentinel/observability';
import {
  type BreachCheckOptions,
  BreachCheckService,
  type HibpRangeTransport,
  type RangeResponse,
} from './breach-check.service.js';

/**
 * `correct horse battery staple`, SHA-1:
 * `ABF7AAD6438836DBE526AA231ABDE2D0EEF74D42`.
 * Prefix (the only part that may leave the process): `ABF7A`.
 * Suffix (matched locally): `AD6438836DBE526AA231ABDE2D0EEF74D42`.
 */
const PASSWORD = 'correct horse battery staple';
const DIGEST = 'ABF7AAD6438836DBE526AA231ABDE2D0EEF74D42';
const PREFIX = 'ABF7A';
const SUFFIX = 'AD6438836DBE526AA231ABDE2D0EEF74D42';

const DEFAULT_OPTIONS: BreachCheckOptions = {
  enabled: true,
  rangeUrl: 'https://api.pwnedpasswords.com/range',
  timeoutMs: 2_000,
};

/** A range body in HIBP's wire format: uppercase 35-hex suffix, colon, count, CRLF. */
function rangeBody(entries: readonly (readonly [string, number])[]): string {
  return entries.map(([suffix, count]) => `${suffix}:${count}`).join('\r\n');
}

const OTHER_SUFFIXES = [
  ['0018A45C4D1DEF81644B54AB7F969B88D65', 1],
  ['00D4F6E8FA6EECAD2A3AA415EEC418D38EC', 2],
] as const;

interface Harness {
  readonly service: BreachCheckService;
  readonly calls: { url: string; headers: Record<string, string>; signal: AbortSignal }[];
  readonly logLines: () => Record<string, unknown>[];
}

function harness(respond: HibpRangeTransport, options: Partial<BreachCheckOptions> = {}): Harness {
  const calls: Harness['calls'] = [];
  const written: string[] = [];
  const logger: Logger = createLogger({
    service: 'test',
    level: 'debug',
    pretty: false,
    stream: {
      write(chunk: string): boolean {
        written.push(chunk);
        return true;
      },
      // The two other members pino's stream duck-type needs. Cast rather than
      // building a real Writable: this collects strings, nothing more.
    } as unknown as NonNullable<Parameters<typeof createLogger>[0]['stream']>,
  });

  const transport: HibpRangeTransport = (url, init) => {
    calls.push({ url, headers: { ...init.headers }, signal: init.signal });
    return respond(url, init);
  };

  return {
    service: new BreachCheckService({ ...DEFAULT_OPTIONS, ...options }, transport, logger),
    calls,
    logLines: () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const respondWith = (response: RangeResponse): HibpRangeTransport => {
  return () => Promise.resolve(response);
};

describe('BreachCheckService k-anonymity', () => {
  it('sends exactly five hex characters of the SHA-1 and nothing else', async () => {
    // THIS IS THE ENTIRE PRIVACY CLAIM OF ADR-0015. The URL is asserted as an
    // exact string rather than by substring or regex, so an implementation that
    // later sent six characters, the whole digest, or the digest as a query
    // parameter fails here rather than passing a looser check.
    const { service, calls } = harness(
      respondWith({ status: 200, body: rangeBody(OTHER_SUFFIXES) }),
    );

    await service.isBreached(PASSWORD);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.pwnedpasswords.com/range/ABF7A');
  });

  it('never puts the password, the full digest, or the suffix on the wire', async () => {
    const { service, calls } = harness(
      respondWith({ status: 200, body: rangeBody(OTHER_SUFFIXES) }),
    );

    await service.isBreached(PASSWORD);

    const onTheWire = JSON.stringify({
      url: calls[0]?.url,
      headers: calls[0]?.headers,
    });
    expect(onTheWire).not.toContain(PASSWORD);
    expect(onTheWire).not.toContain(DIGEST);
    expect(onTheWire).not.toContain(SUFFIX);
    // The prefix is the one thing that is supposed to be there.
    expect(onTheWire).toContain(PREFIX);
  });

  it('honours a configured range URL, with or without a trailing slash', async () => {
    for (const rangeUrl of ['https://hibp.internal/range', 'https://hibp.internal/range/']) {
      const { service, calls } = harness(respondWith({ status: 200, body: '' }), { rangeUrl });
      await service.isBreached(PASSWORD);
      expect(calls[0]?.url).toBe('https://hibp.internal/range/ABF7A');
    }
  });

  it('sends the Add-Padding header', async () => {
    // HIBP's own API documentation (haveibeenpwned.com/API/v3, Pwned Passwords
    // section, read 2026-08-25): the header "Pads out responses to ensure all
    // results contain a random number of records between 800 and 1,000", and
    // "Padded entries always have a password count of 0 and can be discarded
    // once received". The zero-count filter this implies is asserted below.
    const { service, calls } = harness(respondWith({ status: 200, body: '' }));
    await service.isBreached(PASSWORD);
    expect(calls[0]?.headers['Add-Padding']).toBe('true');
  });
});

describe('BreachCheckService matching', () => {
  it('reports a breach when the local suffix is in the returned list', async () => {
    const { service } = harness(
      respondWith({ status: 200, body: rangeBody([...OTHER_SUFFIXES, [SUFFIX, 42]]) }),
    );
    expect(await service.isBreached(PASSWORD)).toBe(true);
  });

  it('reports no breach when the suffix is absent from a well-formed list', async () => {
    const { service } = harness(respondWith({ status: 200, body: rangeBody(OTHER_SUFFIXES) }));
    expect(await service.isBreached(PASSWORD)).toBe(false);
  });

  it('matches case-insensitively on the returned suffix', async () => {
    const { service } = harness(
      respondWith({ status: 200, body: rangeBody([[SUFFIX.toLowerCase(), 7]]) }),
    );
    expect(await service.isBreached(PASSWORD)).toBe(true);
  });

  it('discards a padded entry, which always carries a count of zero', async () => {
    // Without this, a padded response — which HIBP returns for every request
    // carrying Add-Padding — could report a breach for a password that has
    // never appeared in one.
    const { service } = harness(
      respondWith({ status: 200, body: rangeBody([...OTHER_SUFFIXES, [SUFFIX, 0]]) }),
    );
    expect(await service.isBreached(PASSWORD)).toBe(false);
  });
});

describe('BreachCheckService fail-open behaviour', () => {
  it('is a no-op that never calls the transport when disabled', async () => {
    // ADR-0015: the flag defaults to false, so no test suite anywhere in this
    // repository depends on a third party being reachable.
    const { service, calls } = harness(
      respondWith({ status: 200, body: rangeBody([[SUFFIX, 99]]) }),
      { enabled: false },
    );
    expect(await service.isBreached(PASSWORD)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('allows the password when the range API times out', async () => {
    vi.useFakeTimers();
    try {
      const { service, logLines } = harness(
        (_url, init) =>
          new Promise<RangeResponse>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
        { timeoutMs: 2_000 },
      );
      const pending = service.isBreached(PASSWORD);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toBe(false);
      expect(logLines().map((line) => line['reason'])).toContain('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows the password on a 500', async () => {
    const { service, logLines } = harness(
      respondWith({ status: 500, body: 'Internal Server Error' }),
    );
    expect(await service.isBreached(PASSWORD)).toBe(false);
    expect(logLines().map((line) => line['reason'])).toContain('unexpected-status');
  });

  it('allows the password on a garbage body', async () => {
    const { service, logLines } = harness(
      respondWith({ status: 200, body: '<html><body>Service unavailable</body></html>' }),
    );
    expect(await service.isBreached(PASSWORD)).toBe(false);
    expect(logLines().map((line) => line['reason'])).toContain('unparseable-body');
  });

  it('allows the password when the transport throws', async () => {
    const { service, logLines } = harness(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await service.isBreached(PASSWORD)).toBe(false);
    expect(logLines().map((line) => line['reason'])).toContain('transport-error');
  });
});

describe('BreachCheckService logging', () => {
  it('logs at warn, with an elapsed time and no fragment of the password anywhere', async () => {
    // Critical security rule 6, and Ruling 7 specifically: not the password,
    // not its SHA-1, and NOT the five-character prefix either. The prefix
    // narrows the candidate space and buys nothing diagnostically, and a log
    // aggregator keeps what it is given forever.
    const { service, logLines } = harness(() => Promise.reject(new Error('ECONNREFUSED')));
    await service.isBreached(PASSWORD);

    const lines = logLines();
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    expect(line['level']).toBe('warn');
    expect(typeof line['elapsedMs']).toBe('number');

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(DIGEST);
    expect(serialised).not.toContain(SUFFIX);
    expect(serialised).not.toContain(PREFIX);
    expect(serialised).not.toContain(PREFIX.toLowerCase());
  });

  it('logs nothing on a successful lookup', async () => {
    const { service, logLines } = harness(
      respondWith({ status: 200, body: rangeBody(OTHER_SUFFIXES) }),
    );
    await service.isBreached(PASSWORD);
    expect(logLines()).toHaveLength(0);
  });
});
