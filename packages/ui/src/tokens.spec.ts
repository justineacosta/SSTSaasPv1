import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return [...css.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] ?? '').sort();
}

describe('design tokens', () => {
  const light = tokensIn(':root {');

  it('defines the full palette on bare :root, so nothing is dark-mode-only', () => {
    expect(light).toContain('--color-bg');
    expect(light).toContain('--color-text');
    expect(light).toContain('--color-accent');
  });

  it('defines all five severity accents and all five severity surfaces', () => {
    for (const level of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(light).toContain(`--color-severity-${level}`);
      expect(light).toContain(`--color-severity-${level}-surface`);
    }
  });

  it('redefines the dark palette under the system media query', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('redefines the dark palette under the explicit toggle too', () => {
    expect(css).toContain(":root[data-theme='dark']");
  });

  it('defines identical token sets in both dark blocks — a drift here is a theme bug', () => {
    expect(tokensIn(":root:not([data-theme='light'])")).toEqual(
      tokensIn(":root[data-theme='dark']"),
    );
  });

  it('defines every dark token in light as well, so no token exists in only one theme', () => {
    for (const token of tokensIn(":root[data-theme='dark']")) {
      expect(light, token).toContain(token);
    }
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('gives body an explicit background rather than inheriting the host', () => {
    expect(css).toMatch(/body\s*\{[^}]*background-color:\s*var\(--color-bg\)/);
  });
});
