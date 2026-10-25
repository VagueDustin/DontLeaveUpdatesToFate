/**
 * mac-apps.ts: which apps in /Applications can still launch.
 *
 * The macOS counterpart of the Windows shortcut census. Exit code 0 is not proof an update worked: an
 * installer can replace a bundle and leave it without the executable its Info.plist names. Taking a
 * census before and after a run, and reporting bundles that went from launchable to not, catches that
 * whole class without per-app knowledge. The census reuses the Windows record shape so the same diff
 * and the same notice serve both platforms (`lnk` is the bundle path here).
 */

import { constants as FS } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShortcutCensus, ShortcutRecord } from '../shortcuts.js';

/** The CFBundleExecutable value from an XML plist, or null. */
function executableFromXml(plist: string): string | null {
  return /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(plist)?.[1] ?? null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, FS.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Inspect one bundle.
 *
 * XML plists (most apps) are read properly. Binary plists cannot be parsed without `plutil`, and
 * `plutil` would need the bundle path as an argument, which the argument filter refuses when it has a
 * space ("Google Chrome.app"). For those, an executable in Contents/MacOS whose name appears in the
 * plist bytes is accepted: the executable name is stored there as a plain ASCII string.
 */
async function inspect(app: string): Promise<ShortcutRecord> {
  const name = app.slice(app.lastIndexOf('/') + 1).replace(/\.app$/i, '');
  const record = (target: string, ok: boolean): ShortcutRecord => ({ lnk: app, name, target, ok });

  // iPhone and iPad apps installed on a Mac are wrapped: `WrappedBundle` links to an iOS-style bundle
  // whose Info.plist and executable sit at its root rather than under Contents/.
  const wrapped = join(app, 'WrappedBundle');
  const isWrapped = await stat(wrapped).then((s) => s.isDirectory(), () => false);
  const macos = isWrapped ? wrapped : join(app, 'Contents', 'MacOS');
  const plistPath = isWrapped ? join(wrapped, 'Info.plist') : join(app, 'Contents', 'Info.plist');

  let raw: Buffer;
  try {
    raw = await readFile(plistPath);
  } catch {
    return record(macos, false);
  }

  const text = raw.toString('latin1');
  if (!text.startsWith('bplist')) {
    const exe = executableFromXml(raw.toString('utf8'));
    if (!exe) return record(macos, false);
    const target = join(macos, exe);
    return record(target, await isExecutableFile(target));
  }

  let entries: string[] = [];
  try {
    entries = await readdir(macos);
  } catch {
    return record(macos, false);
  }
  for (const entry of entries) {
    const target = join(macos, entry);
    if (text.includes(entry) && (await isExecutableFile(target))) return record(target, true);
  }
  return record(macos, false);
}

/** Census every `.app` directly inside the given folders. Missing folders are skipped. */
export async function takeAppCensusIn(dirs: string[]): Promise<ShortcutCensus> {
  const census: ShortcutCensus = new Map();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const apps = names.filter((n) => n.toLowerCase().endsWith('.app')).map((n) => join(dir, n));
    const records = await Promise.all(apps.map(inspect));
    for (const r of records) census.set(r.lnk, r);
  }
  return census;
}

/** The run log's census messages, which talk about shortcuts on Windows and apps on a Mac. */
export function censusWords(platform: 'windows' | 'mac') {
  if (platform === 'mac') {
    return {
      before: 'Recording which apps can launch before the run.',
      after: 'Checking those apps can still launch.',
      unreadable: 'Could not read the Applications folder; skipping that check.',
      read: (n: number, seconds: string) => `${n} app(s) checked in ${seconds}s.`,
      broken: (n: number) => `${n} app(s) stopped launching during this run, an update moved or removed what they need.`,
    };
  }
  return {
    before: 'Recording shortcut targets before the run.',
    after: 'Checking those shortcuts still resolve.',
    unreadable: 'Could not read the shortcut list; skipping that check.',
    read: (n: number, seconds: string) => `${n} shortcut(s) read in ${seconds}s.`,
    broken: (n: number) => `${n} shortcut(s) stopped working during this run, an upgrade moved or removed its target.`,
  };
}
