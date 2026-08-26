import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from './logger.js';
import { runWithRequestContext } from './context.js';
import { REDACTED } from './redaction.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({ service: 'api', level: 'debug', pretty: false, stream });
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits structured JSON carrying the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info({ scanId: 'scn_01J' }, 'Scan created');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: 'api', msg: 'Scan created', scanId: 'scn_01J' });
  });

  it('injects the ambient request context into every line', () => {
    const { logger, lines } = captureLogger();
    runWithRequestContext(
      { requestId: 'req_01J', organizationId: 'org_01J', userId: 'usr_01J' },
      () => logger.info('hello'),
    );
    expect(lines[0]).toMatchObject({
      requestId: 'req_01J',
      organizationId: 'org_01J',
      userId: 'usr_01J',
    });
  });

  it('redacts secrets in the logged object', () => {
    const { logger, lines } = captureLogger();
    logger.info({ headers: { authorization: 'Bearer abc' } }, 'inbound');
    expect((lines[0] as { headers: { authorization: string } }).headers.authorization).toBe(
      REDACTED,
    );
  });

  it('omits context keys entirely when there is no ambient context', () => {
    const { logger, lines } = captureLogger();
    logger.info('no context');
    expect(lines[0]).not.toHaveProperty('requestId');
  });

  it('redacts a secret embedded in the msg string, leaving the rest readable', () => {
    const { logger, lines } = captureLogger();
    logger.info('exchanging token=Bearer FIXTURE-not-a-real-jwt.header.signature now');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe(`exchanging token=${REDACTED} now`);
  });

  it('leaves a msg with no secret shape byte-identical', () => {
    const { logger, lines } = captureLogger();
    logger.info('Scan completed with 3 findings');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe('Scan completed with 3 findings');
  });

  it('redacts a secret inside Error.message when the error is the first argument', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error(err, 'request failed');
    const out = lines[0] as { err: { message: string } };
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('redacts a secret inside Error.message when logged as { err }', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error({ err }, 'request failed');
    const out = lines[0] as { err: { message: string } };
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('keeps the stack after serialization and redacts any secret inside it', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('token leak: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error(err, 'boom');
    const out = lines[0] as { err: { stack: string } };
    expect(typeof out.err.stack).toBe('string');
    expect(out.err.stack.length).toBeGreaterThan(0);
    expect(out.err.stack).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.err.stack).toContain(REDACTED);
  });

  it('redacts a secret in both msg and the serialised error for a bare Error with no message argument', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error(err);
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.err.message).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.msg).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('redacts a secret in both msg and the serialised error for { err } with no message argument', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error({ err });
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.err.message).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.msg).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('uses the explicit message when one is given, redacted, without regressing error serialization', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('inner detail: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error(err, 'request failed for token=Bearer FIXTURE-not-a-real-jwt.header.signature');
    const out = lines[0] as { msg: string; err: { message: string; type: string } };
    expect(out.msg).toBe(`request failed for token=${REDACTED}`);
    expect(out.err.message).toBe(`inner detail: ${REDACTED}`);
    expect(out.err.type).toBe('Error');
  });

  it('leaves msg byte-identical to a non-secret Error.message when logged alone', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('connection reset by peer');
    logger.error(err);
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).toBe('connection reset by peer');
    expect(out.err.message).toBe('connection reset by peer');
  });

  it('redacts a shape-recognisable secret passed as a trailing interpolation argument', () => {
    const { logger, lines } = captureLogger();
    logger.info('token=%s', 'Bearer FIXTURE-not-a-real-jwt.header.signature');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe(`token=${REDACTED}`);
  });

  it('leaves a non-secret trailing interpolation argument unchanged', () => {
    const { logger, lines } = captureLogger();
    logger.info('scan %s completed', 'scn_01J');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe('scan scn_01J completed');
  });

  it('redacts a secret in child logger bindings, and again on a second line from the same child', () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({ apiKey: 'Bearer FIXTURE-not-a-real-jwt.header.signature' });
    child.info('first line');
    child.info('second line');
    expect(lines).toHaveLength(2);
    expect((lines[0] as { apiKey: string }).apiKey).toBe(REDACTED);
    expect((lines[1] as { apiKey: string }).apiKey).toBe(REDACTED);
  });

  it('redacts a secret in grandchild bindings, proving the override is inherited', () => {
    const { logger, lines } = captureLogger();
    const grandchild = logger
      .child({ requestId: 'req_1' })
      .child({ apiKey: 'Bearer FIXTURE-not-a-real-jwt.header.signature' });
    grandchild.info('grandchild line');
    const out = lines[0] as { requestId: string; apiKey: string };
    expect(out.requestId).toBe('req_1');
    expect(out.apiKey).toBe(REDACTED);
  });

  it('leaves a non-secret child binding byte-identical', () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({ organizationId: 'org_01J', requestId: 'req_01J' });
    child.info('plain');
    const out = lines[0] as { organizationId: string; requestId: string };
    expect(out.organizationId).toBe('org_01J');
    expect(out.requestId).toBe('req_01J');
  });

  it('still honours the two-argument child(bindings, options) form, including level', () => {
    const { logger, lines } = captureLogger();
    const child = logger.child(
      { apiKey: 'Bearer FIXTURE-not-a-real-jwt.header.signature' },
      { level: 'warn' },
    );
    child.info('should be suppressed by level');
    child.warn('should appear');
    expect(lines).toHaveLength(1);
    const out = lines[0] as { level: number; apiKey: string; msg: string };
    expect(out.msg).toBe('should appear');
    expect(out.apiKey).toBe(REDACTED);
  });

  // Crash-safety properties, tested here through createLogger rather than
  // only against redact() directly: a guard proven safe in isolation but
  // never exercised through the actual per-call pipeline is not proven safe
  // in the position that matters (C2/I4 review finding).

  it('does not crash on a throwing getter at the top level of the merge object', () => {
    const { logger, lines } = captureLogger();
    const hostile = {
      get poison(): string {
        throw new Error('getter exploded');
      },
      ok: 'value',
    };
    expect(() => logger.info(hostile, 'hostile object')).not.toThrow();
    const out = lines[0] as { poison: string; ok: string };
    expect(out.poison).toBe('[unreadable]');
    expect(out.ok).toBe('value');
  });

  it('does not crash on a circular reference reaching the logger', () => {
    const { logger, lines } = captureLogger();
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    const payload = { nested: circular };
    expect(() => logger.info(payload, 'circular object')).not.toThrow();
    const out = lines[0] as { nested: { name: string; self: string } };
    expect(out.nested.name).toBe('x');
    expect(out.nested.self).toBe('[circular]');
  });

  it('does not crash on a null-prototype object reaching the logger', () => {
    const { logger, lines } = captureLogger();
    const nullProto = Object.assign(Object.create(null), { scanId: 'scn_01J' }) as Record<
      string,
      unknown
    >;
    expect(() => logger.info(nullProto, 'null-proto object')).not.toThrow();
    const out = lines[0] as { scanId: string };
    expect(out.scanId).toBe('scn_01J');
  });

  it('does not crash on a non-string Error.message (C3)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('placeholder');
    (err as unknown as { message: unknown }).message = 12345;
    expect(() => logger.error(err)).not.toThrow();
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).toBe(REDACTED);
    expect(out.err.message).toBe(REDACTED);
  });

  it('redacts Error.message when logged with an explicit undefined second argument (C1)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer FIXTURE-not-a-real-jwt.header.signature');
    logger.error(err, undefined);
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).not.toContain('FIXTURE-not-a-real-jwt');
    expect(out.msg).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('drops an own-enumerable toJSON so it cannot resurrect an already-redacted subtree (C2)', () => {
    const { logger, lines } = captureLogger();
    const hostile = {
      a: {
        b: {
          toJSON() {
            return { token: 'Bearer FIXTURE-not-a-real-jwt.header.signature' };
          },
        },
      },
    };
    logger.info(hostile, 'hostile toJSON');
    const out = lines[0] as { a: { b: Record<string, unknown> } };
    expect(out.a.b).toEqual({});
  });

  it('does not let a log-call field shadow the ambient request context (M9)', () => {
    const { logger, lines } = captureLogger();
    runWithRequestContext({ requestId: 'req_real', organizationId: 'org_real' }, () => {
      logger.info({ requestId: 'attacker-controlled' }, 'x');
    });
    const out = lines[0] as { requestId: string; organizationId: string };
    expect(out.requestId).toBe('req_real');
    expect(out.organizationId).toBe('org_real');
  });

  // C3, continued: a Symbol message, or a message whose `toString` throws,
  // makes pino-std-serializers' own `isErrorLike` check false, so
  // `stdSerializers.err` hands back the raw Error unchanged rather than
  // throwing itself — the crash then happened one line later, in this
  // package's own destructuring, reading `.stack` for the first time and
  // triggering `Error.prototype.toString()` -> `ToString(message)`. A
  // narrower try/catch around only the `stdSerializers.err` call did not
  // catch this; these four tests are what proved that.

  it('does not crash on a Symbol Error.message via a bare Error (C3)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('placeholder');
    (err as unknown as { message: unknown }).message = Symbol('sekrit');
    expect(() => logger.error(err)).not.toThrow();
    const out = lines[0] as { err: { type: string; message: string; stack: string } };
    expect(out.err.type).toBe('Error');
    expect(out.err.message).toBe(REDACTED);
    expect(out.err.stack).toBe(REDACTED);
  });

  it('does not crash on a Symbol Error.message via { err } (C3)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('placeholder');
    (err as unknown as { message: unknown }).message = Symbol('sekrit');
    expect(() => logger.error({ err }, 'context msg')).not.toThrow();
    const out = lines[0] as { msg: string; err: { type: string; message: string; stack: string } };
    expect(out.msg).toBe('context msg');
    expect(out.err.type).toBe('Error');
    expect(out.err.message).toBe(REDACTED);
    expect(out.err.stack).toBe(REDACTED);
  });

  it('does not crash on a hostile-toString Error.message via a bare Error (C3)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('placeholder');
    (err as unknown as { message: unknown }).message = {
      toString() {
        throw new Error('hostile toString');
      },
    };
    expect(() => logger.error(err)).not.toThrow();
    const out = lines[0] as { err: { type: string; message: string; stack: string } };
    expect(out.err.type).toBe('Error');
    expect(out.err.message).toBe(REDACTED);
    expect(out.err.stack).toBe(REDACTED);
  });

  it('does not crash on a hostile-toString Error.message via { err } (C3)', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('placeholder');
    (err as unknown as { message: unknown }).message = {
      toString() {
        throw new Error('hostile toString');
      },
    };
    expect(() => logger.error({ err }, 'context msg')).not.toThrow();
    const out = lines[0] as { msg: string; err: { type: string; message: string; stack: string } };
    expect(out.msg).toBe('context msg');
    expect(out.err.type).toBe('Error');
    expect(out.err.message).toBe(REDACTED);
    expect(out.err.stack).toBe(REDACTED);
  });
});
