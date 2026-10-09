/**
 * self-update.test.ts: re-checking must not undo a finished download.
 *
 * The footer's version badge is a "check for updates" button, and it stays one while a verified
 * download is waiting. Pressing it there put the stage back to "available" and pruned the installer
 * it had just verified out of the download directory, so "Close and install" became "Download" again.
 *
 * GitHub is not contacted: `fetch` is stubbed with the release payload, and the download directory is
 * a fresh temp folder holding a stand-in installer.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../src/shared/types.js';
import { SelfUpdater } from '../src/main/self-update.js';

const INSTALLER = 'DontLeaveUpdatesToFate-1.6.0-setup.exe';

const PAYLOAD = {
  tag_name: 'v1.6.0',
  name: '1.6.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/tag/v1.6.0',
  assets: [
    {
      name: INSTALLER,
      size: 4,
      browser_download_url: `https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/download/v1.6.0/${INSTALLER}`,
    },
  ],
};

let dir: string | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('SelfUpdater.check', () => {
  it('keeps a verified download ready when the latest release is still that version', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fate-update-'));
    const downloaded = join(dir, INSTALLER);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }));

    const updater = new SelfUpdater({
      currentVersion: '1.5.1',
      channel: 'installed',
      downloadDir: dir,
      workDir: dir,
      targetExe: 'C:\\Program Files\\Fate\\Fate.exe',
      log: () => undefined,
      onState: () => undefined,
    });

    // Where a successful check and download leave it. The first check prunes the directory, so the
    // stand-in installer is written once that has had the chance to run.
    await updater.check(true);
    expect(updater.snapshot.stage).toBe('available');
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(downloaded, 'stub');
    Object.assign(updater as unknown as { state: UpdateState }, {
      state: { ...updater.snapshot, stage: 'ready', downloaded, verified: true },
    });

    const after = await updater.check(false);
    expect(after.stage).toBe('ready');
    expect(after.downloaded).toBe(downloaded);
    // pruneDownloads is fire-and-forget; give it the chance to have run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(downloaded)).toBe(true);
  });
});
