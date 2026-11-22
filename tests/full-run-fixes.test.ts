/**
 * full-run-fixes.test.ts: what an elevated run of all 102 offered updates got wrong.
 *
 * Every input here is from that run: Chocolatey's own snapshot file, winget's rows, pip's paths and the
 * line of Chocolatey output that was misread. Nothing is spawned.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, UpdateItem } from '../src/shared/types.js';
import { looksLikePermissionFailure } from '../src/main/elevation.js';
import { programKey, readChocolateyInstalls, snapshotDisplayNames } from '../src/main/providers/chocolatey.js';
import { providers, type Provider } from '../src/main/providers/index.js';
import { pipUpgradeArgs } from '../src/main/providers/pip.js';
import { parseWingetUpgrade } from '../src/main/providers/winget.js';
import { holdDuplicates, Session } from '../src/main/session.js';
import { DEFAULT_SETTINGS, type SettingsStore } from '../src/main/settings.js';

// The scan summary cases build a Session, which would otherwise shell out to `net session`.
vi.mock('../src/main/elevation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/elevation.js')>()),
  isElevated: async () => false,
}));

const snapshot = readFileSync(join(import.meta.dirname, 'fixtures', 'choco-registry-python313.xml'), 'utf8');

describe('a program both winget and Chocolatey offer', () => {
  const row = (name: string, id: string, version: string, available: string): string =>
    `${name.padEnd(32)}${id.padEnd(40)}${version.padEnd(10)}${available.padEnd(11)}winget`;
  const lines = [
    row('Name', 'Id', 'Version', 'Available').replace(/winget$/, 'Source'),
    '-'.repeat(99),
    row('Python 3.13.17 (64-bit)', 'Python.Python.3.13', '3.13.17', '3.13.18'),
    row('Python 3.14.10 (64-bit)', 'Python.Python.3.14', '3.14.10', '3.14.11'),
    row('Git', 'Git.Git', '2.55.0.5', '2.56.1'),
  ];

  // What `readChocolateyInstalls` builds from the python313 snapshot.
  const owned = new Map(snapshotDisplayNames(snapshot).map((name) => [programKey(name), 'python313']));
  const items = parseWingetUpgrade(lines, () => null, (name) => owned.get(programKey(name)) ?? null);

  it('reads the Add/Remove Programs names out of a Chocolatey snapshot', () => {
    expect(snapshotDisplayNames(snapshot)).toContain('Python 3.13.16 (64-bit)');
  });

  it('records which Chocolatey package installed it, even a patch release later', () => {
    expect(items[0]).toMatchObject({ id: 'Python.Python.3.13', pinned: false, ownerKey: 'chocolatey:-:python313' });
  });

  it('records nothing for a different minor version or an unrelated program', () => {
    expect(items[1]!.ownerKey).toBeUndefined();
    expect(items[2]!.ownerKey).toBeUndefined();
  });

  const choco = (id: string, pinned = false): UpdateItem => ({
    ...items[0]!,
    key: `chocolatey:-:${id}`,
    provider: 'chocolatey',
    id,
    name: id,
    source: null,
    pinned,
    ownerKey: undefined,
  });

  it('holds the winget row back while Chocolatey offers the same update', () => {
    const [python313, python314, git] = holdDuplicates([...items, choco('python313')]);
    expect(python313).toMatchObject({ pinned: true, source: 'Updated through Chocolatey (python313)' });
    expect(python314).toMatchObject({ pinned: false, source: 'winget' });
    expect(git).toMatchObject({ pinned: false, source: 'winget' });
  });

  it('leaves it live when Chocolatey has no such update, is off, or has it pinned', () => {
    // Off, skipped, or a release behind winget all look the same here: no Chocolatey row.
    expect(holdDuplicates(items)[0]).toMatchObject({ pinned: false, source: 'winget' });
    expect(holdDuplicates([...items, choco('python314')])[0]!.pinned).toBe(false);
    expect(holdDuplicates([...items, choco('python313', true)])[0]!.pinned).toBe(false);
  });
});

describe('matching Chocolatey snapshot folders to installed packages', () => {
  it('pairs each folder with its own package and ignores packages no longer installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fate-choco-'));
    try {
      const names: Record<string, string> = {
        // `python` and `python3` are both prefixes of `python313`; neither may claim its folder.
        'python313.3.13.16': 'Python 3.13.16 (64-bit)',
        'python3.3.14.8': 'Meta Three',
        'imagemagick.app.7.1.2.2500': 'ImageMagick 7.1.2-25',
        'gone.1.0.0': 'Removed Program',
      };
      for (const id of ['python', 'python3', 'python313', 'imagemagick', 'imagemagick.app']) {
        await mkdir(join(root, 'lib', id), { recursive: true });
      }
      for (const [dir, name] of Object.entries(names)) {
        await mkdir(join(root, '.chocolatey', dir), { recursive: true });
        await writeFile(join(root, '.chocolatey', dir, '.registry'), `<key displayName="${name}" />`);
      }
      // A snapshot folder with no .registry file, as Chocolatey leaves when nothing changed.
      await mkdir(join(root, '.chocolatey', 'python313.3.13.17'), { recursive: true });

      // Strict, so a removed package arriving as `undefined` fails rather than being overlooked.
      expect(Object.fromEntries(await readChocolateyInstalls(root))).toStrictEqual({
        'python 3.13 (64-bit)': 'python313',
        'meta three': 'python3',
        'imagemagick 7.1-25': 'imagemagick.app',
      });
      expect((await readChocolateyInstalls(join(root, 'missing'))).size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the scan summary', () => {
  const originals = new Map<Provider, Pick<Provider, 'probe' | 'scan'>>();
  const item = (provider: 'winget' | 'chocolatey', id: string, extra: Partial<UpdateItem> = {}): UpdateItem => ({
    key: `${provider}:-:${id}`,
    provider,
    environment: null,
    id,
    name: id,
    currentVersion: '1.0.0',
    availableVersion: '2.0.0',
    source: provider === 'winget' ? 'winget' : null,
    pinned: false,
    uncertain: false,
    local: false,
    location: null,
    ...extra,
  });

  beforeEach(() => {
    for (const provider of providers) {
      originals.set(provider, { probe: provider.probe, scan: provider.scan });
      const usable = provider.id === 'winget' || provider.id === 'chocolatey';
      provider.probe = async () => ({
        available: usable,
        binary: usable ? 'C:\\stub\\tool.exe' : null,
        version: usable ? '1.0.0' : null,
        unavailable: usable ? null : 'missing',
        unavailableDetail: usable ? null : 'stubbed out',
        environments: [],
      });
      provider.scan = async () =>
        provider.id === 'winget'
          ? [item('winget', 'Python.Python.3.13', { ownerKey: 'chocolatey:-:python313' }), item('winget', 'Git.Git')]
          : provider.id === 'chocolatey'
            ? [item('chocolatey', 'python313')]
            : [];
    }
  });

  afterEach(() => {
    for (const [provider, methods] of originals) Object.assign(provider, methods);
    originals.clear();
  });

  const scanWith = async (disabledProviders: AppSettings['disabledProviders']): Promise<{ session: Session; log: string[] }> => {
    const log: string[] = [];
    const value: AppSettings = { ...DEFAULT_SETTINGS, skipped: [], disabledProviders };
    const session = new Session({ value } as unknown as SettingsStore, {
      onLog: (batch) => log.push(...batch.map((line) => line.text)),
      onScan: () => undefined,
      onRun: () => undefined,
      onProviders: () => undefined,
    });
    await session.refreshProviders();
    await session.startScan();
    return { session, log };
  };

  it('holds the duplicate, and does not count it as waiting', async () => {
    const { session, log } = await scanWith([]);
    const held = session.scanSnapshot.items.find((i) => i.id === 'Python.Python.3.13')!;
    expect(held).toMatchObject({ pinned: true, source: 'Updated through Chocolatey (python313)' });
    // The per-provider results are what the table groups by, so they must agree with the flat list.
    const winget = session.scanSnapshot.results.find((r) => r.provider === 'winget')!;
    expect(winget.items.find((i) => i.id === 'Python.Python.3.13')!.pinned).toBe(true);
    expect(log.some((line) => /2 update\(s\) waiting\. 1 held back\./.test(line))).toBe(true);
  });

  it('leaves the winget row live when Chocolatey is switched off', async () => {
    const { session, log } = await scanWith(['chocolatey']);
    expect(session.scanSnapshot.items.find((i) => i.id === 'Python.Python.3.13')!.pinned).toBe(false);
    expect(log.some((line) => /2 update\(s\) waiting\.$/.test(line))).toBe(true);
  });
});

describe('pip upgrade arguments', () => {
  const userSite = 'C:\\Users\\dev\\AppData\\Roaming\\Python\\Python314\\site-packages';

  it('stays in the user site when that is where the package lives', () => {
    expect(pipUpgradeArgs('numpy', `${userSite}\\numpy`, userSite)).toEqual([
      '-m', 'pip', 'install', '--upgrade', '--user', 'numpy',
    ]);
    // A single-file distribution is located at site-packages itself, in whatever case Python reports.
    expect(pipUpgradeArgs('markdown-it-py', userSite.toUpperCase(), userSite)).toContain('--user');
  });

  it('adds nothing for a package in the interpreter own site-packages, or one with no location', () => {
    const plain = ['-m', 'pip', 'install', '--upgrade', 'rebulk'];
    expect(pipUpgradeArgs('rebulk', 'C:\\Python314\\Lib\\site-packages\\rebulk', userSite)).toEqual(plain);
    expect(pipUpgradeArgs('rebulk', null, userSite)).toEqual(plain);
    expect(pipUpgradeArgs('rebulk', `${userSite}-old\\rebulk`, userSite)).toEqual(plain);
  });
});

describe('recognising a permission failure', () => {
  it('is not fooled by a file name containing "Elevation"', () => {
    const line =
      'Preparing: C:\\Users\\dev\\AppData\\Local\\Temp\\chocolatey\\2362b61e4799a0ac49302de9\\vs_bootstrapper_d15\\VSInstallerElevationService.Contracts.dll...';
    expect(looksLikePermissionFailure(line)).toBe(false);
  });

  it('still recognises the real phrasings', () => {
    expect(looksLikePermissionFailure('This operation requires elevation.')).toBe(true);
    expect(looksLikePermissionFailure('Run from an elevated prompt')).toBe(true);
    expect(looksLikePermissionFailure('Access is denied.')).toBe(true);
    expect(looksLikePermissionFailure('failed with ERROR_ELEVATION_REQUIRED (740)')).toBe(true);
  });
});
