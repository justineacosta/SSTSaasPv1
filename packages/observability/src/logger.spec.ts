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
    logger.info('exchanging token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def now');
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
    const err = new Error('auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error(err, 'request failed');
    const out = lines[0] as { err: { message: string } };
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('redacts a secret inside Error.message when logged as { err }', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error({ err }, 'request failed');
    const out = lines[0] as { err: { message: string } };
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('keeps the stack after serialization and redacts any secret inside it', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('token leak: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error(err, 'boom');
    const out = lines[0] as { err: { stack: string } };
    expect(typeof out.err.stack).toBe('string');
    expect(out.err.stack.length).toBeGreaterThan(0);
    expect(out.err.stack).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.err.stack).toContain(REDACTED);
  });

  it('redacts a secret in both msg and the serialised error for a bare Error with no message argument', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error(err);
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.err.message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.msg).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('redacts a secret in both msg and the serialised error for { err } with no message argument', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error({ err });
    const out = lines[0] as { msg: string; err: { message: string } };
    expect(out.msg).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.err.message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out.msg).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
  });

  it('uses the explicit message when one is given, redacted, without regressing error serialization', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('inner detail: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error(
      err,
      'request failed for token=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    );
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
    logger.info('token=%s', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe(`token=${REDACTED}`);
  });

  it('leaves a non-secret trailing interpolation argument unchanged', () => {
    const { logger, lines } = captureLogger();
    logger.info('scan %s completed', 'scn_01J');
    const out = lines[0] as { msg: string };
    expect(out.msg).toBe('scan scn_01J completed');
  });

  it('leaves the existing top-level err message/stack redaction unchanged', () => {
    const { logger, lines } = captureLogger();
    const err = new Error('auth failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    logger.error(err, 'request failed');
    const out = lines[0] as { err: { message: string; stack: string } };
    expect(out.err.message).toBe(`auth failed: ${REDACTED}`);
    expect(out.err.stack).toContain(REDACTED);
    expect(out.err.stack).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });
});
