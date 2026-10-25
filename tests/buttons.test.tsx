/**
 * buttons.test.tsx: the toolbar's buttons follow the button system (rendered without a browser).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import './renderer-env.js';
import { Toolbar } from '../src/renderer/src/components/Toolbar.js';

function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
}

describe('toolbar buttons', () => {
  const html = renderToStaticMarkup(<Toolbar />);
  const all = buttons(html);

  it('renders some buttons', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it('gives every button the btn class', () => {
    for (const b of all) expect(b).toMatch(/class="[^"]*\bbtn\b/);
  });

  it('has exactly one gold primary', () => {
    expect(all.filter((b) => /\bbtn--primary\b/.test(b))).toHaveLength(1);
  });

  it('styles buttons with classes, never inline', () => {
    for (const b of all) expect(b).not.toMatch(/\sstyle="/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('button CSS contract', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'src/renderer/src/styles/fate/controls.css'), 'utf8');
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('makes the primary a gilded capsule from the brand metal tokens', () => {
    const primary = rule('.btn--primary');
    expect(primary).toContain('var(--metal-light)');
    expect(primary).toContain('var(--metal-dark)');
    expect(primary).toContain('var(--font-display)');
    expect(rule('.btn')).toContain('corner-shape: squircle');
  });

  it('squishes on press and springs back', () => {
    expect(rule('.btn:active:not(:disabled)')).toMatch(/scale\(0\.965\)/);
    expect(rule('.btn')).toContain('var(--fate-press)');
  });

  it('plays the hover sweep once, on a pseudo-element', () => {
    expect(css).toMatch(/\.btn--primary:hover:not\(:disabled\)::after\s*\{[^}]*--btn-sheen/);
    expect(css).toContain('@property --btn-sheen');
  });

  it('disables with the brand surface and text, not opacity', () => {
    const disabled = rule('.btn:disabled');
    expect(disabled).toContain('var(--surface-highest)');
    expect(disabled).toContain('var(--text-faint)');
    expect(disabled).not.toContain('opacity');
    // The primary's metal glow must not survive on a disabled button.
    expect(disabled).toContain('box-shadow: none');
  });

  it('uses a 2px emphasis focus ring', () => {
    expect(rule('.btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--border-emphasis\)/);
  });
});
