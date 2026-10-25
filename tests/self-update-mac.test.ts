/**
 * self-update-mac.test.ts: choosing the Mac artifact, and the helper that swaps the app bundle.
 *
 * The swap test builds a real disk image with `hdiutil`, with an apostrophe in the app's name on
 * purpose: the shipping app is "Don't Leave Updates To Fate.app", so every path the helper touches has
 * one, and a quoting mistake would only ever show up on a real update.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assetFor, pruneDownloads, type Asset } from '../src/main/release.js';
import { macInstallLocationWritable } from '../src/main/platform/mac-update.js';

const mac = process.platform === 'darwin';

const assets: Asset[] = [
  { name: 'DontLeaveUpdatesToFate-1.7.0-setup.exe', size: 1, url: 'https://github.com/a' },
  { name: 'DontLeaveUpdatesToFate-1.7.0-portable.exe', size: 1, url: 'https://github.com/b' },
  { name: 'DontLeaveUpdatesToFate-1.7.0-arm64.dmg', size: 1, url: 'https://github.com/c' },
  { name: 'SHA256SUMS-1.7.0.txt', size: 1, url: 'https://github.com/d' },
];

describe('assetFor on macOS', () => {
  it('offers the arm64 dmg to an installed Mac build', () => {
    expect(assetFor(assets, 'installed', 'darwin')?.name).toBe('DontLeaveUpdatesToFate-1.7.0-arm64.dmg');
  });

  it('keeps the Windows choice unchanged', () => {
    expect(assetFor(assets, 'installed', 'win32')?.name).toBe('DontLeaveUpdatesToFate-1.7.0-setup.exe');
    expect(assetFor(assets, 'portable', 'win32')?.name).toBe('DontLeaveUpdatesToFate-1.7.0-portable.exe');
  });

  it('offers nothing to a dev build', () => {
    expect(assetFor(assets, 'dev', 'darwin')).toBeNull();
  });
});

describe('pruneDownloads', () => {
  it('cleans up an old dmg as well as old exes, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlutf-dl-'));
    for (const n of ['DontLeaveUpdatesToFate-1.6.0-arm64.dmg', 'DontLeaveUpdatesToFate-1.6.0-setup.exe', 'holiday.dmg']) {
      writeFileSync(join(dir, n), 'x');
    }
    await pruneDownloads(dir);
    expect(existsSync(join(dir, 'DontLeaveUpdatesToFate-1.6.0-arm64.dmg'))).toBe(false);
    expect(existsSync(join(dir, 'DontLeaveUpdatesToFate-1.6.0-setup.exe'))).toBe(false);
    expect(existsSync(join(dir, 'holiday.dmg'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!mac)('macInstallLocationWritable', () => {
  it('treats a bundle on a mounted image as not writable', async () => {
    expect(await macInstallLocationWritable("/Volumes/DontLeaveUpdatesToFate/Don't Leave Updates To Fate.app")).toBe(false);
  });

  it('accepts a bundle in a folder this user can write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlutf-apps-'));
    expect(await macInstallLocationWritable(join(dir, 'App.app'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!mac)('swap-app.sh', () => {
  const script = join(import.meta.dirname, '..', 'resources', 'mac', 'swap-app.sh');
  const name = "Don't Fake.app";
  let root: string;
  let dmg: string;

  const bundle = (dir: string, marker: string): void => {
    mkdirSync(join(dir, name, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(dir, name, 'Contents', 'version.txt'), marker);
  };

  const run = (env: Record<string, string>) =>
    spawnSync(script, [], {
      env: { ...process.env, SWAP_PID: '999999', SWAP_APP_OPEN: '/usr/bin/true', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dlutf-swap-"));
    const src = join(root, 'src');
    bundle(src, 'new');
    dmg = join(root, 'update.dmg');
    const made = spawnSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', 'DontLeaveUpdatesToFate', '-srcfolder', src, dmg]);
    expect(made.status).toBe(0);
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('replaces the installed bundle with the one in the image, and logs it', () => {
    const apps = join(root, 'Applications');
    bundle(apps, 'old');
    const log = join(root, 'swap.log');

    const result = run({ SWAP_DMG: dmg, SWAP_INSTALLED: join(apps, name), SWAP_LOG: log });

    expect(result.status).toBe(0);
    expect(readFileSync(join(apps, name, 'Contents', 'version.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(apps, `${name}.old`))).toBe(false);
    expect(readFileSync(log, 'utf8')).toMatch(/swapped/);
  }, 60_000);

  it('leaves the installed bundle alone when the image cannot be read', () => {
    const apps = join(root, 'Applications2');
    bundle(apps, 'old');
    const log = join(root, 'swap2.log');

    const result = run({ SWAP_DMG: join(root, 'missing.dmg'), SWAP_INSTALLED: join(apps, name), SWAP_LOG: log });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(apps, name, 'Contents', 'version.txt'), 'utf8')).toBe('old');
    expect(readFileSync(log, 'utf8')).toMatch(/could not/i);
  }, 60_000);
});

describe('SelfUpdater on macOS', () => {
  const base = {
    currentVersion: '1.7.0',
    channel: 'installed' as const,
    downloadDir: tmpdir(),
    workDir: tmpdir(),
    targetExe: "/Applications/Don't Leave Updates To Fate.app",
    log: () => undefined,
    onState: () => undefined,
  };

  it('hands the verified dmg and the installed bundle to the swap helper', async () => {
    const { SelfUpdater } = await import('../src/main/self-update.js');
    const requests: unknown[] = [];
    const updater = new SelfUpdater({
      ...base,
      mac: { helper: '/x/swap-app.sh', blocked: null, swap: (r) => (requests.push(r), true) },
    });
    Object.assign(updater as unknown as { state: object }, {
      state: { ...updater.snapshot, stage: 'ready', downloaded: '/Users/dev/Downloads/DontLeaveUpdatesToFate-1.8.0-arm64.dmg' },
    });

    expect(updater.install()).toBe(true);
    expect(requests).toEqual([
      {
        helper: '/x/swap-app.sh',
        dmg: '/Users/dev/Downloads/DontLeaveUpdatesToFate-1.8.0-arm64.dmg',
        installed: "/Applications/Don't Leave Updates To Fate.app",
        log: join(tmpdir(), 'handover.log'),
        pid: process.pid,
      },
    ]);
  });

  it('reports why it cannot update in place, and never starts the helper', async () => {
    const { SelfUpdater } = await import('../src/main/self-update.js');
    let started = false;
    const updater = new SelfUpdater({
      ...base,
      mac: { helper: '/x/swap-app.sh', blocked: 'Move the app to Applications to update it here.', swap: () => (started = true) },
    });
    expect(updater.snapshot.blocked).toBe('Move the app to Applications to update it here.');
    Object.assign(updater as unknown as { state: object }, { state: { ...updater.snapshot, stage: 'ready', downloaded: '/x.dmg' } });
    expect(updater.install()).toBe(false);
    expect(started).toBe(false);
  });
});
