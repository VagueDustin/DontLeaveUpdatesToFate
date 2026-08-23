/**
 * shortcuts.ts — detect applications that an upgrade left unlaunchable.
 *
 * WHY THIS EXISTS: exit code 0 is not proof an upgrade worked. Upgrading Epic Games Launcher returned
 * success and Epic's own MSI logged "Installation completed successfully… error status: 0" — but the new
 * version put its binaries somewhere else and did not rewrite the existing Desktop and Start Menu
 * shortcuts, so every way the user had of starting it now pointed at a file that no longer existed.
 * The app reported "Updated". The user found out days later from a "Missing Shortcut" dialog.
 *
 * Rather than encode per-package knowledge, this takes a census of shortcuts before a run and after it,
 * and reports any that USED to resolve and now don't. That attributes breakage by observation and
 * catches the whole class, not just Epic.
 *
 * Reading a .lnk target needs the shell. Rather than ship a .lnk parser or a dependency, this runs a
 * short PowerShell script through `-EncodedCommand`: the payload is base64, which contains none of the
 * characters `exec.ts` refuses, so it needs no quoting and no temp file. (A `-File` path would break on
 * a username containing a space.)
 */

import { runCommand } from './exec.js';
import type { BrokenShortcut } from '../shared/types.js';

/**
 * Enumerate shortcuts in the four places installers actually write them, and report whether each
 * target still resolves.
 *
 * `-lit` on Test-Path so a target containing `[` or `]` is not treated as a wildcard. Errors on any one
 * shortcut are swallowed so one unreadable .lnk cannot lose the whole census.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Desktop')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$out = @()
foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Filter *.lnk -Recurse -Force | ForEach-Object {
    try {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      if ($t) {
        $out += [pscustomobject]@{
          lnk    = $_.FullName
          name   = $_.BaseName
          target = $t
          ok     = [bool](Test-Path -LiteralPath $t)
        }
      }
    } catch { }
  }
}
$out | ConvertTo-Json -Compress -Depth 3
`;

export interface ShortcutRecord {
  lnk: string;
  name: string;
  target: string;
  ok: boolean;
}

/** A census keyed by shortcut path, so before/after can be compared cheaply. */
export type ShortcutCensus = Map<string, ShortcutRecord>;

export async function takeShortcutCensus(timeoutMs = 45_000): Promise<ShortcutCensus> {
  const census: ShortcutCensus = new Map();

  // UTF-16LE base64 is what -EncodedCommand expects.
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

  const result = await runCommand({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    timeoutMs,
  });

  if (result.code !== 0 && result.stdout.trim().length === 0) return census;

  const parsed = safeParse(result.stdout);
  for (const record of parsed) {
    if (typeof record?.lnk !== 'string' || typeof record?.target !== 'string') continue;
    census.set(record.lnk.toLowerCase(), {
      lnk: record.lnk,
      name: typeof record.name === 'string' ? record.name : record.lnk,
      target: record.target,
      ok: record.ok === true,
    });
  }
  return census;
}

/** `ConvertTo-Json` emits a bare object rather than an array when there is exactly one result. */
function safeParse(text: string): Array<Partial<ShortcutRecord>> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (Array.isArray(value)) return value as Array<Partial<ShortcutRecord>>;
    if (value && typeof value === 'object') return [value as Partial<ShortcutRecord>];
    return [];
  } catch {
    return [];
  }
}

/**
 * Shortcuts that resolved in `before` and do not resolve in `after`.
 *
 * A shortcut that was already broken beforehand is not reported — the point is to name what THIS run
 * broke, not to audit pre-existing mess. A shortcut that disappeared entirely is also not reported: an
 * uninstall removing its own shortcut is correct behaviour.
 */
export function diffBrokenShortcuts(
  before: ShortcutCensus,
  after: ShortcutCensus,
): BrokenShortcut[] {
  const broken: BrokenShortcut[] = [];

  for (const [key, now] of after) {
    if (now.ok) continue;
    const was = before.get(key);
    if (!was || !was.ok) continue;
    broken.push({ shortcut: now.lnk, name: now.name, target: now.target });
  }

  return broken.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}
