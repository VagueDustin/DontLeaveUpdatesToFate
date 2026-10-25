/**
 * paths.ts: filesystem helpers shared by the "where is this installed?" resolvers.
 *
 * Every provider answers that question differently, a registry value, a convention under a manager
 * root, a path printed by the tool itself, but they all end up needing the same three things: does
 * this path exist, which of these candidates exists first, and how do I show a 120-character path in
 * a 140-pixel column. Those live here so no adapter reimplements them.
 *
 * Everything is best-effort by construction: a resolver that cannot answer returns null and the row
 * shows a dash. Reporting a path that isn't there would be worse than reporting nothing.
 */

import { access, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { normalize, posix, win32 } from 'node:path';

/**
 * The path flavour a given path is written in, independent of the OS running this code.
 *
 * Registry values and Windows manager roots are always Windows paths, and Homebrew or npm roots on a
 * Mac are always POSIX ones. Choosing by the shape of the input keeps each helper correct for the
 * paths it is actually handed, and keeps the Windows tests meaningful when the suite runs on macOS.
 */
export function pathFor(path: string): typeof win32 | typeof posix {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.includes('\\') ? win32 : posix;
}

/** Absolute in either flavour: `C:\x`, `\\server\share` or `/x`. */
export function isAbsolutePath(path: string): boolean {
  return pathFor(path).isAbsolute(path);
}

/** Does this path exist at all (file or directory)? */
export async function pathExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Does this path exist AND is it a directory? */
export async function dirExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The first candidate that exists, or null. Blank and relative candidates are skipped. */
export async function firstExisting(candidates: Array<string | null | undefined>): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = candidate.trim();
    if (path.length === 0 || !isAbsolutePath(path)) continue;
    if (await pathExists(path)) return normalize(path);
  }
  return null;
}

/**
 * Walk up from a binary to the root a manager keeps its packages under.
 *
 * `C:\ProgramData\chocolatey\bin\choco.exe` with `levels: 2` gives `C:\ProgramData\chocolatey`. Used
 * when the environment variable a manager documents (`ChocolateyInstall`, `SCOOP`) is not set in this
 * process, which is common, because the app may have been launched before the installer set it, or
 * elevated into a different environment block.
 */
export function ancestorOf(binary: string, levels: number): string {
  let path = binary;
  const flavour = pathFor(binary);
  for (let i = 0; i < levels; i++) path = flavour.dirname(path);
  return path;
}

/**
 * Expand `%NAME%` references the way `cmd` would, dropping any that are not set.
 *
 * Registry `InstallLocation` and `DisplayIcon` values regularly contain them, MSI writes
 * `%ProgramFiles%\Vendor\App` verbatim, and a literal `%ProgramFiles%` in the UI is worse than no
 * path at all.
 */
export function expandEnv(value: string): string {
  return value.replace(/%([^%\s]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/**
 * Turn a registry `DisplayIcon` value into the directory that contains it.
 *
 * The value is a path optionally followed by a comma and an icon index (`C:\App\app.exe,0`), and is
 * frequently quoted. Returns null for icons that live in a shared system DLL, which say nothing about
 * where the application is.
 */
export function directoryFromIcon(displayIcon: string): string | null {
  let value = displayIcon.trim();
  if (value.length === 0) return null;

  // Strip a trailing icon index, but only when what precedes it still looks like a path.
  const comma = value.lastIndexOf(',');
  if (comma > 2 && /^-?\d+$/.test(value.slice(comma + 1).trim())) value = value.slice(0, comma);

  value = expandEnv(value.replace(/^"(.*)"$/s, '$1').trim());
  if (value.length === 0 || !win32.isAbsolute(value)) return null;
  if (isSystemPath(value)) return null;

  return win32.dirname(value);
}

/**
 * Pull the program out of an `UninstallString` and return its directory.
 *
 * Worth trying only when it is the app's OWN uninstaller: an MSI product's uninstall string is
 * `MsiExec.exe /X{GUID}`, whose directory is `C:\Windows\System32`, technically a real path and
 * completely useless as an answer to "where is this installed?".
 */
export function directoryFromUninstallString(uninstall: string): string | null {
  const value = expandEnv(uninstall.trim());
  if (value.length === 0) return null;

  // Quoted program, or everything up to the first flag-looking token.
  const quoted = /^"([^"]+)"/.exec(value);
  const program = quoted ? quoted[1]! : (/^(.*?\.exe)\b/i.exec(value)?.[1] ?? '');
  if (!program || !win32.isAbsolute(program)) return null;
  if (isSystemPath(program)) return null;

  return win32.dirname(program);
}

/** Paths under the Windows directory, never a useful answer for "where is this app". */
export function isSystemPath(path: string): boolean {
  const windows = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  const target = win32.normalize(path).toLowerCase();
  return target.startsWith(windows.endsWith(win32.sep) ? windows : windows + win32.sep);
}

/**
 * The user's profile directory, normalised, for "is this a per-user install" checks.
 */
export function homeDir(): string {
  return normalize(process.env.USERPROFILE ?? process.env.HOME ?? 'C:\\Users\\Default');
}

/** Join a manager root and a package name, guarding against a name that would escape the root. */
export function safeJoin(root: string, ...parts: string[]): string | null {
  for (const part of parts) {
    if (part.length === 0) return null;
    if (part.includes('..') || part.includes('/') || part.includes('\\') || part.includes(':')) {
      return null;
    }
  }
  return pathFor(root).join(root, ...parts);
}
