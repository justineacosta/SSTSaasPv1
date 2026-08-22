import { describe, expect, it } from 'vitest';
import { outputPathFromArgv } from './cli-args.js';

const DEFAULT = '/repo/apps/api/openapi.json';

describe('outputPathFromArgv', () => {
  it('falls back to the committed artefact when --out is absent', () => {
    expect(outputPathFromArgv(['node', 'cli.js'], DEFAULT)).toBe(DEFAULT);
  });

  it('returns the path given after --out', () => {
    expect(outputPathFromArgv(['node', 'cli.js', '--out', '/tmp/x.json'], DEFAULT)).toBe(
      '/tmp/x.json',
    );
  });

  it('throws when --out is last, rather than silently writing the committed file', () => {
    // The whole point of the flag is that the caller does NOT want the
    // committed file touched. Falling back here would overwrite it.
    expect(() => outputPathFromArgv(['node', 'cli.js', '--out'], DEFAULT)).toThrow(
      '--out requires a path argument',
    );
  });

  it('throws when --out is followed by another flag', () => {
    expect(() => outputPathFromArgv(['node', 'cli.js', '--out', '--quiet'], DEFAULT)).toThrow(
      '--out requires a path argument',
    );
  });
});
