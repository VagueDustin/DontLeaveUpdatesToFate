/**
 * mac-update.ts: installing a downloaded update on macOS.
 *
 * The app cannot replace its own bundle while it runs, so a helper shipped in the app's resources
 * (`resources/mac/swap-app.sh`) does the work after this process exits: mount the image, copy the new
 * bundle beside the old one, wait for this pid to go, swap, clear quarantine and relaunch. If anything
 * fails it keeps or restores the old bundle and relaunches that.
 *
 * Every path goes to the helper through its environment, not its arguments. The app's own name
 * ("Don't Leave Updates To Fate") carries an apostrophe, which the argument filter rightly refuses, and
 * an environment variable is never parsed by anything.
 */

import { spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';

/** False for a bundle on a mounted image (run straight from the dmg) or in a folder this user cannot write. */
export async function macInstallLocationWritable(appPath: string): Promise<boolean> {
  if (appPath.startsWith('/Volumes/')) return false;
  try {
    await access(dirname(appPath), FS.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The .app bundle this process runs from, from the executable inside it. */
export function bundleOf(executable: string): string | null {
  const at = executable.indexOf('.app/Contents/MacOS/');
  return at === -1 ? null : executable.slice(0, at + 4);
}

export interface MacSwapRequest {
  helper: string;
  dmg: string;
  installed: string;
  log: string;
  pid: number;
}

/** Start the swap helper so it outlives this process. True when it started. */
export function startMacSwap(request: MacSwapRequest): boolean {
  try {
    const child = spawn(request.helper, [], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        SWAP_DMG: request.dmg,
        SWAP_INSTALLED: request.installed,
        SWAP_LOG: request.log,
        SWAP_PID: String(request.pid),
      },
    });
    child.unref();
    return typeof child.pid === 'number';
  } catch {
    return false;
  }
}
