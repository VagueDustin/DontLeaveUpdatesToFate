/**
 * session-disabled.test.ts: a manager switched off in Settings must not upgrade anything.
 *
 * Switching a manager off keeps its binary on the provider info, so switching it back on needs no
 * re-probe. The run loop only checked for that binary, so a run started with the manager's rows still
 * selected upgraded them anyway.
 *
 * Nothing here spawns a package manager: the provider objects are stubbed for the duration, and the
 * elevation probe is mocked so the run does not shell out to `net session`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, RunSnapshot, UpdateItem } from '../src/shared/types.js';
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
const upgraded: string[] = [];

beforeEach(() => {
  upgraded.length = 0;
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
    provider.scan = async () => [item('left-pad')];
    provider.upgrade = async (target) => {
      upgraded.push(target.id);
      return succeeded;
    };
  }
});

afterEach(() => {
  for (const [provider, methods] of originals) Object.assign(provider, methods);
  originals.clear();
});

describe('a manager switched off in Settings', () => {
  it('upgrades nothing, and says why on the job', async () => {
    const session = new Session(fakeSettings(), {
      onLog: () => undefined,
      onScan: () => undefined,
      onRun: () => undefined,
      onProviders: () => undefined,
    });

    await session.refreshProviders();
    await session.startScan();
    expect(session.scanSnapshot.items.map((i) => i.key)).toEqual(['npm:-:left-pad']);

    // What the Settings switch sends, after the rows were already on screen and selected.
    await session.updateSettings({ disabledProviders: ['npm'] });

    const run: RunSnapshot = await session.startRun(['npm:-:left-pad']);
    expect(upgraded).toEqual([]);
    expect(run.jobs).toMatchObject([
      { key: 'npm:-:left-pad', status: 'skipped', detail: expect.stringMatching(/switched off/i) },
    ]);

    session.dispose();
  });

  it('upgrades again once it is switched back on', async () => {
    const session = new Session(fakeSettings(), {
      onLog: () => undefined,
      onScan: () => undefined,
      onRun: () => undefined,
      onProviders: () => undefined,
    });

    await session.refreshProviders();
    await session.startScan();
    await session.updateSettings({ disabledProviders: ['npm'] });
    await session.updateSettings({ disabledProviders: [] });

    await session.startRun(['npm:-:left-pad']);
    expect(upgraded).toEqual(['left-pad']);

    session.dispose();
  });
});
