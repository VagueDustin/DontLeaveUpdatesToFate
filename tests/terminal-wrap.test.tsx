/**
 * The log pane wraps long lines instead of scrolling sideways, so a line is one row or several and
 * the windowing has to know where each one starts. These are the sums it does that with, and the
 * stylesheet rules they depend on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexAtOffset, wrappedOffsets, wrappedRows } from '../src/renderer/src/hooks/useVirtual.js';

describe('wrapping a log line', () => {
  it('gives an empty line its one row', () => {
    expect(wrappedRows(0, 50)).toBe(1);
  });

  it('breaks only once the line is longer than the row', () => {
    expect(wrappedRows(50, 50)).toBe(1);
    expect(wrappedRows(51, 50)).toBe(2);
    // A `winget upgrade` row in the pane at its default width.
    expect(wrappedRows(155, 49)).toBe(4);
  });

  it('survives a pane too narrow to have been measured', () => {
    expect(wrappedRows(10, 0)).toBe(10);
  });
});

describe('where each line starts', () => {
  const offsets = wrappedOffsets([10, 120, 0, 50], 50, 18);

  it('stacks the lines by their wrapped height, and ends with the total', () => {
    expect([...offsets]).toEqual([0, 18, 72, 90, 108]);
  });

  it('finds the line under a scroll position', () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 17)).toBe(0);
    expect(indexAtOffset(offsets, 18)).toBe(1);
    expect(indexAtOffset(offsets, 71)).toBe(1);
    expect(indexAtOffset(offsets, 72)).toBe(2);
    expect(indexAtOffset(offsets, 100)).toBe(3);
  });

  it('clamps a position outside the list to its ends', () => {
    expect(indexAtOffset(offsets, -40)).toBe(0);
    expect(indexAtOffset(offsets, 5000)).toBe(3);
    expect(indexAtOffset(wrappedOffsets([], 50, 18), 10)).toBe(0);
  });
});

describe('the log pane stylesheet', () => {
  const read = (file: string): string => readFileSync(join(import.meta.dirname, '..', 'src/renderer/src/styles', file), 'utf8');
  const app = read('app.css');
  const rule = (css: string, selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('wraps at any character, which is what makes a line a predictable number of rows', () => {
    const text = rule(app, '.term__text');
    expect(text).toContain('white-space: break-spaces');
    expect(text).toContain('line-break: anywhere');
  });

  it('keeps the ruler on one row, or a narrow pane measures as forty columns wide', () => {
    const ruler = rule(app, '.term__probe i');
    expect(ruler).toContain('white-space: nowrap');
    expect(ruler).toContain('display: inline-block');
  });

  it('never scrolls sideways', () => {
    expect(rule(app, '.term__scroll')).toContain('overflow-x: hidden');
    expect(rule(app, '.term__sizer')).not.toContain('max-content');
    expect(rule(app, '.term__line')).not.toContain('max-content');
  });

  it('gives the log more of the window than a package gets', () => {
    expect(read('workbench.css')).toMatch(/\.work\[data-tab='log'\] \{\s*grid-template-columns:[^;]*1\.2fr\)/);
  });
});
