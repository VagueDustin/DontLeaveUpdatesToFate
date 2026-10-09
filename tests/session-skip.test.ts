/**
 * session-skip.test.ts: a skipped package must stay gone until the next scan.
 *
 * Skipping one hid it in the renderer's copy of the scan only. The main process kept it, and the scan
 * snapshot it pushes when a run ends put it straight back on screen, in the "waiting" count and in
 * "Update all", as soon as any other package finished updating.
 *
 * Nothing here spawns a package manager: the provider objects are stubbed for the duration, and the
 * elevation probe is mocked so the run does not shell out to `net session`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ScanSnapshot, UpdateItem } from '../src/shared/types.js';
import type { CommandResult } from '../src/main/exec.js';
import { providers, type Provider } from '../src/main/providers/index.js';
import { Session } from '../src/main/session.js';
import { DEFAULT_SETTINGS, normaliseSettings, type SettingsStore } from '../src/main/settings.js';

vi.mock('../src/main/elevation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/elevation.js')>()),
  isElevated: async () => false,
}));

const item = (id: string): UpdateItem => ({
  key: `npm:-:${id}`,
  provider: 'npm',
  environment: null,
  id,
  name: id,
  currentVersion: '1.0.0',
  availableVersion: '2.0.0',
  source: 'global',
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
});

const succeeded: CommandResult = {
  code: 0,
  stdout: '',
  stderr: '',
  lines: [],
  timedOut: false,
  cancelled: false,
  spawnFailed: false,
  durationMs: 1,
  display: 'npm install',
};

function fakeSettings(): SettingsStore {
  let value: AppSettings = { ...DEFAULT_SETTINGS, skipped: [], verifyShortcuts: false };
  return {
    get value() {
      return value;
    },
    patch: async (partial: Partial<AppSettings>) => (value = normaliseSettings({ ...value, ...partial })),
  } as unknown as SettingsStore;
}

const originals = new Map<Provider, Pick<Provider, 'probe' | 'scan' | 'upgrade'>>();

beforeEach(() => {
  for (const provider of providers) {
    originals.set(provider, { probe: provider.probe, scan: provider.scan, upgrade: provider.upgrade });
    const usable = provider.id === 'npm';
    provider.probe = async () => ({
      available: usable,
      binary: usable ? 'C:\\stub\\npm.cmd' : null,
      version: usable ? '1.0.0' : null,
      unavailable: usable ? null : 'missing',
      unavailableDetail: usable ? null : 'stubbed out',
      environments: [],
    });
    provider.scan = async () => [item('kept'), item('declined')];
    provider.upgrade = async () => succeeded;
  }
});

afterEach(() => {
  for (const [provider, methods] of originals) Object.assign(provider, methods);
  originals.clear();
});

describe('skipping a package', () => {
  it('keeps it out of the scan snapshot a finished run pushes', async () => {
    const pushed: ScanSnapshot[] = [];
    const session = new Session(fakeSettings(), {
      onLog: () => undefined,
      onScan: (snapshot) => pushed.push(snapshot),
      onRun: () => undefined,
      onProviders: () => undefined,
    });

    await session.refreshProviders();
    await session.startScan();
    expect(session.scanSnapshot.items.map((i) => i.id)).toEqual(['declined', 'kept']);

    // What the row menu's "Never update this" sends.
    await session.updateSettings({
      skipped: [{ key: 'npm:declined', version: null, name: 'declined', at: 0 }],
    });
    expect(session.scanSnapshot.items.map((i) => i.id)).toEqual(['kept']);

    // Updating the other package ends with a pushed snapshot, which is what used to resurrect it.
    pushed.length = 0;
    await session.startRun(['npm:-:kept']);
    expect(pushed.length).toBeGreaterThan(0);
    for (const snapshot of pushed) {
      expect(snapshot.items.some((i) => i.id === 'declined')).toBe(false);
    }

    session.dispose();
  });
});
