/**
 * registry.ts: the Add/Remove Programs index, used to answer "where is this installed?".
 *
 * winget's `upgrade` output has no location column and no flag that adds one. What it DOES have is a
 * Name column that is verbatim the ARP `DisplayName`, winget correlates its catalogue against the
 * same registry Windows draws Apps & Features from. So the index is built once per scan and rows are
 * matched back by name.
 *
 * Read through PowerShell rather than `reg.exe` because `ConvertTo-Json` gives a shape that cannot be
 * mis-parsed, where `reg query /s` output has to be re-assembled from indented `NAME  TYPE  DATA`
 * lines whose DATA may itself contain the separator. The script travels as base64 through
 * `-EncodedCommand`, so it needs no quoting and no temp file (see shortcuts.ts for the same trick).
 *
 * Nothing here is load-bearing: every failure path yields an empty index and rows simply show no
 * location.
 */

import { runCommand } from './exec.js';
import { directoryFromIcon, directoryFromUninstallString, dirExists, expandEnv } from './paths.js';

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty -Path $paths |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  ForEach-Object {
    [pscustomobject]@{
      n = [string]$_.DisplayName
      l = [string]$_.InstallLocation
      i = [string]$_.DisplayIcon
      u = [string]$_.UninstallString
    }
  } | ConvertTo-Json -Compress -Depth 2
`;

export interface ArpEntry {
  /** DisplayName, verbatim. */
  name: string;
  installLocation: string;
  displayIcon: string;
  uninstallString: string;
}

/**
 * A name→location lookup with two tiers.
 *
 * `exact` is the normalised DisplayName. `loose` has the version number and the architecture suffix
 * stripped, and deliberately DROPS any key that more than one distinct location claims: three
 * ".NET Runtime" entries that differ only by version must yield no answer rather than a coin-flip.
 */
export interface ArpIndex {
  exact: Map<string, string>;
  loose: Map<string, string>;
  size: number;
}

export const EMPTY_ARP_INDEX: ArpIndex = { exact: new Map(), loose: new Map(), size: 0 };

/** Case- and whitespace-insensitive form of a display name. */
export function normaliseName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Drop the parts of a display name that drift between the catalogue and the registry.
 *
 * `CPUID CPU-Z 2.20` in winget's list is `CPUID CPU-Z 2.21` in the registry the moment the upgrade
 * lands, and `GOG GALAXY (64-bit)` is plain `GOG GALAXY` there. Returns null when stripping leaves
 * nothing worth matching on.
 */
export function looseName(name: string): string | null {
  let text = normaliseName(name);

  // Trailing architecture / scope suffixes, possibly several: "(64-bit)", "(x64)", "(user)".
  for (;;) {
    const next = text.replace(/\s*\((?:x64|x86|64-bit|32-bit|arm64|user|machine|per-user)\)\s*$/i, '');
    if (next === text) break;
    text = next;
  }

  // A trailing version, with or without a separating dash: "runtime - 8.0.29", "cpu-z 2.20".
  text = text.replace(/\s*[-–, ]?\s*v?\d+(?:\.\d+)+(?:[a-z]\d*)?\s*$/i, '');

  text = text.trim();
  return text.length >= 3 ? text : null;
}

/**
 * Pick the best on-disk directory an ARP entry points at.
 *
 * `InstallLocation` first, because it is the only field that MEANS "install location". After that the
 * two derivable paths need arbitration, and the rule is: when the uninstaller sits at or above the
 * icon's directory, the uninstaller's directory is the application root and the icon's is a subfolder
 * of it. OBS Studio settles it, icon `…\obs-studio\bin\64bit\obs64.exe`, uninstaller
 * `…\obs-studio\uninstall.exe`. The root is the useful answer.
 */
export async function locationOf(entry: ArpEntry): Promise<string | null> {
  const declared = expandEnv(entry.installLocation.trim().replace(/^"(.*)"$/s, '$1')).replace(
    /[\\/]+$/,
    '',
  );
  if (declared.length > 0 && (await dirExists(declared))) return declared;

  const iconDir = directoryFromIcon(entry.displayIcon);
  const uninstallDir = directoryFromUninstallString(entry.uninstallString);

  if (iconDir && uninstallDir) {
    const preferRoot = iconDir.toLowerCase().startsWith(uninstallDir.toLowerCase());
    const first = preferRoot ? uninstallDir : iconDir;
    const second = preferRoot ? iconDir : uninstallDir;
    if (await dirExists(first)) return first;
    if (await dirExists(second)) return second;
    return null;
  }

  const only = iconDir ?? uninstallDir;
  if (only && (await dirExists(only))) return only;
  return null;
}

/** Turn resolved registry entries into the two-tier lookup. Pure, so it is unit-testable. */
export function buildIndex(resolved: Array<{ name: string; location: string }>): ArpIndex {
  const exact = new Map<string, string>();
  const loose = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const { name, location } of resolved) {
    const key = normaliseName(name);
    // First writer wins: HKLM is read before HKCU, and a machine-wide entry is the better answer.
    if (key.length > 0 && !exact.has(key)) exact.set(key, location);

    const soft = looseName(name);
    if (!soft || ambiguous.has(soft)) continue;
    const existing = loose.get(soft);
    if (existing === undefined) loose.set(soft, location);
    else if (existing.toLowerCase() !== location.toLowerCase()) {
      // Two different apps normalise to the same name, answer with nothing rather than a guess.
      loose.delete(soft);
      ambiguous.add(soft);
    }
  }

  return { exact, loose, size: resolved.length };
}

/** Look a display name up, exact first then loose. */
export function lookup(index: ArpIndex, name: string): string | null {
  const exact = index.exact.get(normaliseName(name));
  if (exact) return exact;
  const soft = looseName(name);
  return (soft ? index.loose.get(soft) : undefined) ?? null;
}

/** `ConvertTo-Json` collapses a one-element array to a bare object. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

/** Read the registry and resolve every entry to a directory that exists. */
export async function readArpIndex(timeoutMs = 30_000): Promise<ArpIndex> {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

  const result = await runCommand({
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    timeoutMs,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || 'null');
  } catch {
    return EMPTY_ARP_INDEX;
  }

  const entries: ArpEntry[] = [];
  for (const raw of asArray(parsed)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.n === 'string' ? record.n : '';
    if (name.trim().length === 0) continue;
    entries.push({
      name,
      installLocation: typeof record.l === 'string' ? record.l : '',
      displayIcon: typeof record.i === 'string' ? record.i : '',
      uninstallString: typeof record.u === 'string' ? record.u : '',
    });
  }

  // Resolving touches the disk once or twice per entry; a few hundred `stat` calls in parallel cost
  // far less than the registry read that produced them.
  const resolved = await Promise.all(
    entries.map(async (entry) => ({ name: entry.name, location: await locationOf(entry) })),
  );

  return buildIndex(
    resolved.filter((r): r is { name: string; location: string } => r.location !== null),
  );
}
