/**
 * brand.test.ts: the app's declared theme matches what it actually ships, and motion stays on the
 * compositor.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { THEME, TIER } from '../src/shared/brand.js';
import { SURFACE_BASE } from '../src/shared/brand-tokens.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function surfaceBaseOf(theme: string, css: string): string {
  const block = new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return /--surface-base:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? '';
}

describe('brand declaration', () => {
  it('brand.ts matches the theme and tier the app ships', () => {
    const html = read('src/renderer/index.html');
    expect(html).toContain(`data-theme="${THEME}"`);
    expect(html).toContain(`data-tier="${TIER}"`);
  });

  it('pre-paint colour is the theme surface-base, so launch shows no flash of another navy', () => {
    const tokens = read('src/renderer/src/styles/brand/tokens.css');
    expect(SURFACE_BASE.toLowerCase()).toBe(surfaceBaseOf(THEME, tokens).toLowerCase());
  });

  it('vendors the brand motion tokens', () => {
    const tokens = read('src/renderer/src/styles/brand/tokens.css');
    for (const name of ['--dur-press', '--dur-fast', '--dur-base', '--dur-spring', '--ease-out', '--ease-spring']) {
      expect(tokens, name).toContain(`${name}:`);
    }
  });
});

describe('motion lint', () => {
  it('check-brand rejects animating layout or paint-heavy properties', () => {
    const out = execFileSync('node', ['scripts/check-brand.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/motion check passed/);
  });
});
