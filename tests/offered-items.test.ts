/**
 * offered-items.test.ts: what the table, the counts and "Update all" are allowed to offer.
 *
 * A manager switched off in Settings kept its rows on screen, in the waiting count and in
 * "Update all" until the next scan. They are filtered rather than removed, so switching the manager
 * back on restores them without scanning again.
 */

import { describe, expect, it } from 'vitest';
import type { AppSettings, ScanSnapshot, UpdateItem } from '../src/shared/types.js';
import { offeredItems } from '../src/shared/offered.js';
import { DEFAULT_SETTINGS } from '../src/main/settings.js';

const item = (provider: UpdateItem['provider'], id: string, uncertain = false): UpdateItem => ({
  key: `${provider}:-:${id}`,
  provider,
  environment: null,
  id,
  name: id,
  currentVersion: uncertain ? 'Unknown' : '1.0.0',
  availableVersion: '2.0.0',
  source: null,
  pinned: false,
  uncertain,
  local: false,
  location: null,
});

const scan = {
  phase: 'done',
  startedAt: 0,
  finishedAt: 1,
  inFlight: [],
  results: [],
  items: [item('winget', 'Git.Git'), item('npm', 'npm'), item('winget', 'Ubisoft.Connect', true)],
} as ScanSnapshot;

const ids = (items: UpdateItem[]): string[] => items.map((i) => i.id);

describe('offeredItems', () => {
  it('leaves out every row from a manager that is switched off', () => {
    const settings = { ...DEFAULT_SETTINGS, includeUncertain: true, disabledProviders: ['winget'] } as AppSettings;
    expect(ids(offeredItems(scan, settings))).toEqual(['npm']);
  });

  it('offers them again once it is switched back on', () => {
    const settings = { ...DEFAULT_SETTINGS, includeUncertain: true, disabledProviders: [] } as AppSettings;
    expect(ids(offeredItems(scan, settings))).toEqual(['Git.Git', 'npm', 'Ubisoft.Connect']);
  });

  it('still hides an unknown installed version unless asked to show them', () => {
    const settings = { ...DEFAULT_SETTINGS, includeUncertain: false, disabledProviders: [] } as AppSettings;
    expect(ids(offeredItems(scan, settings))).toEqual(['Git.Git', 'npm']);
  });
});
