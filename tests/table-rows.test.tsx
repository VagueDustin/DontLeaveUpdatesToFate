/**
 * table-rows.test.ts: what the table renders while a scan fills it in.
 */

import { describe, expect, it } from 'vitest';

import type { UpdateItem } from '../src/shared/types.js';
import { fileManagerName } from '../src/shared/keys.js';
import { tableRowsFor } from '../src/renderer/src/state/table-rows.js';

const item = (key: string): UpdateItem => ({
  key,
  provider: 'npm',
  environment: null,
  id: key,
  name: key,
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  source: null,
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
});

describe('tableRowsFor', () => {
  it('pads with skeleton rows to the visible count while a scan is still running', () => {
    const rows = tableRowsFor([item('a'), item('b')], { scanning: true, visibleCount: 6, fresh: [], scrolled: false });
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item', 'skeleton', 'skeleton', 'skeleton', 'skeleton']);
  });

  it('shows no skeletons once the scan is done', () => {
    expect(tableRowsFor([item('a')], { scanning: false, visibleCount: 6, fresh: [], scrolled: false })).toHaveLength(1);
  });

  it('staggers the rows that just arrived, 35ms apart', () => {
    const rows = tableRowsFor([item('a'), item('b'), item('c')], {
      scanning: true,
      visibleCount: 3,
      fresh: ['a', 'b', 'c'],
      scrolled: false,
    });
    expect(rows.map((r) => (r.kind === 'item' ? r.enterDelayMs : 'skel'))).toEqual([0, 35, 70]);
  });

  it('caps the stagger at 300ms', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const rows = tableRowsFor(keys.map(item), { scanning: false, visibleCount: 20, fresh: keys, scrolled: false });
    const last = rows.at(-1)!;
    expect(last.kind === 'item' && last.enterDelayMs).toBe(300);
  });

  it('does not animate rows that were already there, or anything once the user scrolls', () => {
    const rows = tableRowsFor([item('a'), item('b')], { scanning: false, visibleCount: 6, fresh: ['b'], scrolled: false });
    expect(rows.map((r) => (r.kind === 'item' ? r.enterDelayMs : null))).toEqual([null, 0]);
    const scrolled = tableRowsFor([item('a')], { scanning: false, visibleCount: 6, fresh: ['a'], scrolled: true });
    expect(scrolled[0]!.kind === 'item' && scrolled[0]!.enterDelayMs).toBeNull();
  });
});

describe('fileManagerName', () => {
  it('says Finder on a Mac and Explorer on Windows', () => {
    expect(fileManagerName('mac')).toBe('Finder');
    expect(fileManagerName('windows')).toBe('Explorer');
  });
});
