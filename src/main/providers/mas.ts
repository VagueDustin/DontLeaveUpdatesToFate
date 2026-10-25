/**
 * mas.ts: Mac App Store apps, through the free `mas` command-line tool.
 *
 * `mas` only updates apps for the Apple Account signed in to the App Store, and it is not installed by
 * default; the sidebar offers to install it with Homebrew when it is missing.
 */

import type { UpdateItem } from '../../shared/types.js';
import { firstExisting } from '../paths.js';
import { buildItem, locate, probeVersion, run, scanFailed } from './util.js';
import type { ProbeResult, Provider } from './types.js';

export interface MasRow {
  id: string;
  name: string;
  installed: string;
  available: string;
}

/** `  302584613  Kindle       (7.64   -> 7.69)`; names can contain spaces. */
export function parseMasOutdated(text: string): MasRow[] {
  const rows: MasRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s+\(\s*(\S+)\s+->\s+(\S+)\s*\)\s*$/.exec(line);
    if (m) rows.push({ id: m[1]!, name: m[2]!, installed: m[3]!, available: m[4]! });
  }
  return rows;
}

export const MAS_MISSING_DETAIL = 'Install mas to check App Store apps';

export const masProvider: Provider = {
  id: 'mas',
  label: 'App Store',
  command: 'mas',
  kind: 'system',
  blurb: 'Apps from the Mac App Store, for the Apple Account signed in to the App Store.',
  needsElevation: false,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('mas');
    if (!binary) {
      return {
        available: false,
        binary: null,
        version: null,
        unavailable: 'missing',
        unavailableDetail: MAS_MISSING_DETAIL,
        environments: [],
      };
    }
    const version = await probeVersion(binary, ['version'], timeoutMs);
    return version === null
      ? {
          available: false,
          binary,
          version: null,
          unavailable: 'incapable',
          unavailableDetail: 'mas is on PATH but did not report a version.',
          environments: [],
        }
      : { available: true, binary, version, unavailable: null, unavailableDetail: null, environments: [] };
  },

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const result = await run(rt, info.binary, ['outdated']);
    const items: UpdateItem[] = [];
    for (const row of parseMasOutdated(result.stdout)) {
      const item = buildItem({
        provider: 'mas',
        id: row.id,
        name: row.name,
        current: row.installed,
        available: row.available,
        location: await firstExisting([`/Applications/${row.name}.app`]),
      });
      if (item) items.push(item);
    }
    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  upgrade: (item, info, rt) => run(rt, info.binary!, ['upgrade', item.id]),
};
