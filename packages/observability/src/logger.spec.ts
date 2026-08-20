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
});
