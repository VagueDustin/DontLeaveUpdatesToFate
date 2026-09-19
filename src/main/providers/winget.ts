/**
 * winget, the Windows Package Manager.
 *
 * The broadest provider by far: on a typical machine it accounts for most of the list, because it
 * tracks ordinary desktop applications alongside CLI tools.
 *
 * `winget upgrade` has no JSON output, so the fixed-width table is parsed with `table.ts`. It prints
 * up to three sections, the main list, then "…require explicit targeting for upgrade", then a
 * count line, and `parseTables` handles all of them because each carries its own header row.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderInfo, UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { dirExists } from '../paths.js';
import { EMPTY_ARP_INDEX, lookup, readArpIndex, type ArpIndex } from '../registry.js';
import { parseTables } from '../table.js';
import { buildItem, locate, probeVersion, run, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider, type ProviderRuntime } from './types.js';

const HEADERS = ['Name', 'Id', 'Version', 'Available', 'Source'];

/** Lines that close a table section rather than belonging to it. */
function isEnd(line: string): boolean {
  const t = line.trim();
  return (
    /^\d+\s+(?:upgrades?|packages?)\b/i.test(t) ||
    /^The following packages/i.test(t) ||
    /^No installed package/i.test(t) ||
    /^Failed when searching source/i.test(t) ||
    /^\d+\s+package\(s\)/i.test(t)
  );
}

/**
 * Rows winget emits that are not packages.
 *
 * When a name is truncated winget appends an ellipsis; those rows are still valid because the id
 * column (the only field used to build the upgrade command) is never truncated.
 */
function isRowUsable(cells: string[]): boolean {
  const [name, id, available] = cells;
  if (!id || !available) return false;
  if (!name) return false;
  // A row where the id column caught a wrapped continuation of the previous line.
  if (/\s/.test(id)) return false;
  return true;
}

/**
 * Turn the whole of `winget upgrade`'s output into items. Pure, so it is covered by unit tests
 * against output captured from a real machine rather than only by running winget.
 *
 * `locateBy` is injected rather than imported so the parser stays pure: the tests exercise the
 * table-to-item mapping without a registry, and the live scan passes a lookup closed over the ARP
 * index it read alongside the upgrade query.
 */
export function parseWingetUpgrade(
  lines: string[],
  locateBy: (name: string, id: string) => string | null = () => null,
): UpdateItem[] {
  const items: UpdateItem[] = [];
  const seen = new Set<string>();

  for (const table of parseTables(lines, { labels: HEADERS, isEnd })) {
    for (const cells of table.rows) {
      if (!isRowUsable(cells)) continue;
      const [name, id, current, available, source] = cells;

      const item = buildItem({
        provider: 'winget',
        id: id!,
        name: name!,
        current: current ?? '',
        available: available!,
        source: source ?? null,
        location: locateBy(name!, id!),
      });
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
    }
  }
  return items;
}

export const wingetProvider: Provider = {
  id: 'winget',
  label: 'Windows Package Manager',
  command: 'winget',
  kind: 'system',
  blurb: 'Desktop applications and CLI tools from the winget and Microsoft Store catalogues.',
  needsElevation: true,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('winget');
    if (!binary) return NOT_FOUND('winget');

    const version = await probeVersion(binary, ['--version'], timeoutMs);
    if (version === null) {
      return {
        available: false,
        binary,
        version: null,
        unavailable: 'incapable',
        unavailableDetail:
          'winget is on PATH but did not report a version. The App Installer package may need repairing.',
        environments: [],
      };
    }
    return {
      available: true,
      binary,
      version,
      unavailable: null,
      unavailableDetail: null,
      environments: [],
    };
  },

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];

    /*
      Both halves in flight at once. `winget upgrade` spends most of its six seconds waiting on the
      catalogue, and the registry read is a second of local I/O, running them in sequence would put
      the whole of that second on the clock for nothing.
    */
    const [result, arp, portables] = await Promise.all([
      run(rt, info.binary, [
        'upgrade',
        '--include-unknown',
        '--disable-interactivity',
        '--accept-source-agreements',
      ]),
      readArpIndex(rt.timeoutMs).catch(() => EMPTY_ARP_INDEX),
      readPortablePackages().catch(() => new Map<string, string>()),
    ]);

    const items = parseWingetUpgrade(result.lines, (name, id) =>
      portables.get(id.toLowerCase()) ?? lookup(arp, name),
    );

    const located = items.filter((item) => item.location !== null).length;
    if (items.length > 0) {
      rt.emit(
        `Located ${located} of ${items.length} on disk (${arp.size} installed programs indexed).`,
        'system',
      );
    }

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    const args = [
      'upgrade',
      '--id',
      item.id,
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ];

    // Targeting the source avoids an ambiguity prompt when an id exists in both catalogues.
    if (item.source === 'winget' || item.source === 'msstore') args.push('--source', item.source);
    // Packages whose installed version winget could not determine need this to be considered at all.
    if (item.uncertain) args.push('--include-unknown');

    return run(rt, info.binary!, args);
  },
};

/**
 * winget's own "portable" installs, which never appear in Add/Remove Programs with a usable location.
 *
 * They land in `%LOCALAPPDATA%\Microsoft\WinGet\Packages\<PackageId>_<source hash>`, Deno and
 * yt-dlp's FFmpeg on this machine, so the package id can be recovered from the directory name and
 * matched directly, no name-guessing involved. Machine-scope portables use the ProgramFiles root.
 */
async function readPortablePackages(): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'WinGet', 'Packages') : null,
  ].filter((root): root is string => root !== null);

  for (const root of roots) {
    if (!(await dirExists(root))) continue;
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      // `<Publisher.Product>_<source>_<hash>`, the id is everything before the first underscore.
      const id = name.split('_')[0]?.toLowerCase();
      if (!id || found.has(id)) continue;
      found.set(id, join(root, name));
    }
  }

  return found;
}
