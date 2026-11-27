/**
 * session-confirm.test.ts: an update only counts once the manager stops offering it.
 *
 * Found on a real elevated run. `winget upgrade --id Logitech.GHUB` printed "Successfully installed"
 * and exited 0, the row was marked Updated and removed from the list, and the next scan offered the
 * same 2026.4.919028 to 2026.7.992920 again: the installer had handed off to its own background
 * updater and returned. So after a run the session scans each manager that updated something, and
 * any package still listed at its old version is taken back.
 *
 * Nothing here spawns a package manager: the provider objects are stubbed for the duration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, LogLine, UpdateItem } from '../src/shared/types.js';
import type { CommandResult } from '../src/main/exec.js';
import { providers, type Provider } from '../src/main/providers/index.js';
import { Session } from '../src/main/session.js';
import { DEFAULT_SETTINGS, normaliseSettings, type SettingsStore } from '../src/main/settings.js';

vi.mock('../src/main/elevation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/elevation.js')>()),
  isElevated: async () => true,
}));

const item = (id: string, currentVersion = '1.0.0'): UpdateItem => ({
  key: `npm:-:${id}`,
  provider: 'npm',
  environment: null,
  id,
  name: id,
  currentVersion,
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
/** What the manager lists as outdated; a test changes it to say what an upgrade really did. */
let outdated: UpdateItem[] = [];
let scans = 0;
let scanFails = false;

beforeEach(() => {
  outdated = [item('took'), item('stuck')];
  scans = 0;
  scanFails = false;
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
    provider.scan = async () => {
      scans += 1;
      if (scanFails && scans > 1) throw new Error('the registry did not answer');
      return outdated;
    };
    provider.upgrade = async (target) => {
      // "took" really upgrades. "stuck" exits 0 and changes nothing, as G HUB's installer did.
      if (target.id === 'took') outdated = outdated.filter((entry) => entry.id !== 'took');
      return succeeded;
    };
  }
});

afterEach(() => {
  for (const [provider, methods] of originals) Object.assign(provider, methods);
  originals.clear();
});

async function ready(): Promise<{ session: Session; log: LogLine[] }> {
  const log: LogLine[] = [];
  const session = new Session(fakeSettings(), {
    onLog: (batch) => void log.push(...batch),
    onScan: () => undefined,
    onRun: () => undefined,
    onProviders: () => undefined,
  });
  await session.refreshProviders();
  await session.startScan();
  return { session, log };
}

describe('after a run, each update is confirmed against the manager', () => {
  it('takes back an "Updated" whose version did not move, and keeps it on the list', async () => {
    const { session } = await ready();
    const run = await session.startRun(['npm:-:took', 'npm:-:stuck']);

    expect(run.jobs.find((job) => job.key === 'npm:-:took')).toMatchObject({ status: 'success' });
    expect(run.jobs.find((job) => job.key === 'npm:-:stuck')).toMatchObject({
      status: 'failed',
      retryable: true,
      detail: expect.stringMatching(/reported success, but 1\.0\.0 is still installed/),
    });
    expect(session.counters).toEqual({ updated: 1, failed: 1, skipped: 0 });
    // Only what really updated leaves the list.
    expect(session.scanSnapshot.items.map((entry) => entry.key)).toEqual(['npm:-:stuck']);
    session.dispose();
  });

  it('asks once per manager, not once per package', async () => {
    const { session } = await ready();
    await session.startRun(['npm:-:took', 'npm:-:stuck']);
    // The scan that filled the list, and one more to confirm.
    expect(scans).toBe(2);
    session.dispose();
  });

  it('counts an update that moved the version, even if a newer one is still offered', async () => {
    const { session } = await ready();
    const real = providers.find((provider) => provider.id === 'npm')!;
    real.upgrade = async () => {
      outdated = [item('took', '1.5.0'), item('stuck', '1.5.0')];
      return succeeded;
    };
    const run = await session.startRun(['npm:-:took', 'npm:-:stuck']);
    expect(run.jobs.map((job) => job.status)).toEqual(['success', 'success']);
    session.dispose();
  });

  it('changes nothing when the manager cannot be asked', async () => {
    scanFails = true;
    const { session, log } = await ready();
    const run = await session.startRun(['npm:-:took', 'npm:-:stuck']);
    expect(run.jobs.map((job) => job.status)).toEqual(['success', 'success']);
    session.dispose();
    expect(log.some((line) => /could not confirm its updates/.test(line.text))).toBe(true);
  });

  it('leaves an update that is waiting for a restart alone', async () => {
    const { session } = await ready();
    const real = providers.find((provider) => provider.id === 'npm')!;
    // MSI's "succeeded, reboot required". The old version shows until the restart, by design.
    real.upgrade = async () => ({ ...succeeded, code: 3010 });
    const run = await session.startRun(['npm:-:stuck']);
    expect(run.jobs[0]).toMatchObject({ status: 'success', detail: expect.stringMatching(/restart/) });
    // Nothing else succeeded, so there was nothing to confirm and no second scan.
    expect(scans).toBe(1);
    session.dispose();
  });

  it('does not call an unreadable version unchanged', async () => {
    // winget's "Unknown": the same before and after, whatever the installer did.
    outdated = [{ ...item('stuck', 'Unknown'), uncertain: true }];
    const { session } = await ready();
    await session.updateSettings({ includeUncertain: true });
    const run = await session.startRun(['npm:-:stuck']);
    expect(run.jobs[0]).toMatchObject({ status: 'success' });
    session.dispose();
  });

  it('does not ask at all when nothing was updated', async () => {
    const { session } = await ready();
    await session.updateSettings({ disabledProviders: ['npm'] });
    await session.startRun(['npm:-:took']);
    expect(scans).toBe(1);
    session.dispose();
  });
});
