/**
 * reveal.ts: show a path in the system file manager, shared by both platforms.
 *
 * Checked first, because `showItemInFolder` on a path that no longer exists opens a bare file manager
 * window at some arbitrary place, which reads as a bug rather than as "that is gone". A missing path
 * falls back to its parent, and the boolean lets the renderer say so.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { shell } from 'electron';

export async function revealWithShell(path: string): Promise<boolean> {
  const target = path.trim();
  if (target.length === 0) return false;

  if (existsSync(target)) {
    shell.showItemInFolder(target);
    return true;
  }
  const parent = dirname(target);
  if (parent !== target && existsSync(parent)) {
    await shell.openPath(parent);
    return true;
  }
  return false;
}
