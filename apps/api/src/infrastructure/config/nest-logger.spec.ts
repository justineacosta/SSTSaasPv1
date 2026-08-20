import { describe, expect, it } from 'vitest';
import { NestLoggerBridge, type BridgeableLogger } from './nest-logger.js';

interface Line {
  readonly level: string;
  readonly bindings: Record<string, unknown>;
  readonly message: string;
}

function recorder(): { logger: BridgeableLogger; lines: Line[] } {
  const lines: Line[] = [];
  const record =
    (level: string) =>
    (bindings: object, message: string): void => {
      lines.push({ level, bindings: bindings as Record<string, unknown>, message });
    };
  return {
    lines,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
    },
  };
}

describe('NestLoggerBridge', () => {
  it.each([
    ['log', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
    ['verbose', 'debug'],
    ['fatal', 'fatal'],
  ])('maps Nest %s onto the structured logger at %s', (nestLevel, pinoLevel) => {
    const { logger, lines } = recorder();
    const bridge = new NestLoggerBridge(logger);
    bridge[nestLevel as 'log']('Nest says hello', 'RoutesResolver');
    expect(lines).toEqual([
      { level: pinoLevel, bindings: { nestContext: 'RoutesResolver' }, message: 'Nest says hello' },
    ]);
  });

  it('never emits a plain string — every line carries structured bindings', () => {
    // monitoring.md §2: structured JSON, never plain strings. Nest's own
    // bootstrap output is the one source of unstructured lines in this process,
    // which is exactly why it is bridged rather than left alone.
    const { logger, lines } = recorder();
    new NestLoggerBridge(logger).log('No context supplied');
    expect(lines[0]!.bindings).toEqual({});
    expect(lines[0]!.message).toBe('No context supplied');
  });

  it('renders a non-string message without calling toString on hostile input', () => {
    const { logger, lines } = recorder();
    const hostile = {
      get toString() {
        throw new Error('nope');
      },
    };
    expect(() => {
      new NestLoggerBridge(logger).error(hostile);
    }).not.toThrow();
    expect(typeof lines[0]!.message).toBe('string');
  });

  it('passes an Error through as `err` so the redacting serialiser sees it', () => {
    const { logger, lines } = recorder();
    const error = new Error('connect to redis://user:hunter2@10.0.0.7:6379 failed');
    new NestLoggerBridge(logger).error(error, 'ExceptionsHandler');
    expect(lines[0]!.bindings.err).toBe(error);
    expect(lines[0]!.message).not.toContain('hunter2');
  });
});
