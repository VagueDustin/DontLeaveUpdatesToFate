/**
 * Scoop.
 *
 * VERIFICATION NOTE: scoop is not installed on the machine this was built on, so unlike winget,
 * chocolatey, npm, pip and rustup this adapter is written from scoop's documented `status` output
 * rather than from captured real output. It is built to fail safe, an unrecognised format yields
 * zero rows instead of wrong rows, because `buildItem` rejects anything without a usable id and a
 * version that is genuinely newer.
 *
 * `scoop status` compares installed versions against the *local* bucket manifests. Those manifests
 * are refreshed by `scoop update`, which does a git pull on every bucket. This provider deliberately
 * does NOT run that: it would mutate the user's buckets as a side effect of pressing "Scan". The
 * blurb says so, so a stale result is explainable rather than mysterious.
 */

import { join } from 'node:path';
import type { UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { ancestorOf, firstExisting, homeDir, safeJoin } from '../paths.js';
import { parseTables } from '../table.js';
import { buildItem, locate, probeVersion, run, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider } from './types.js';

/**
 * The roots scoop installs into, user scope first.
 *
 * `SCOOP` and `SCOOP_GLOBAL` are the documented overrides; `~\scoop` and `%ProgramData%\scoop` are the
 * defaults. Walking up from the resolved shim covers a relocated install whose variable is set at a
 * scope this process cannot see, `…\scoop\shims\scoop.cmd` is two levels down.
 */
export function scoopRoots(binary: string | null): string[] {
  const roots = [
    process.env.SCOOP?.trim(),
    binary ? ancestorOf(binary, 2) : null,
    join(homeDir(), 'scoop'),
    process.env.SCOOP_GLOBAL?.trim(),
    process.env.ProgramData ? join(process.env.ProgramData, 'scoop') : null,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const value = root?.replace(/[\/]+$/, '');
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const HEADERS = ['Name', 'Installed Version', 'Latest Version'];

/** scoop mixes advisory lines into the same stream as the table. */
function isEnd(line: string): boolean {
  return /^(?:WARN|ERROR|INFO)\b/i.test(line.trim()) || /^Scoop\b/i.test(line.trim());
}

export const scoopProvider: Provider = {
  id: 'scoop',
  label: 'Scoop',
  command: 'scoop',
  kind: 'system',
  blurb: 'User-scope packages from Scoop buckets, compared against your last bucket refresh.',
  needsElevation: false,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('scoop');
    if (!binary) return NOT_FOUND('scoop');

    const version = await probeVersion(binary, ['--version'], timeoutMs);
    if (version === null) {
      return {
        available: false,
        binary,
        version: null,
        unavailable: 'incapable',
        unavailableDetail: 'scoop is on PATH but did not report a version.',
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

    const result = await run(rt, info.binary, ['status']);
    const items: UpdateItem[] = [];
    const roots = scoopRoots(info.binary);

    for (const table of parseTables(result.lines, { labels: HEADERS, isEnd })) {
      for (const cells of table.rows) {
        const [name, installed, latest] = cells;
        if (!name || !latest) continue;

        // `<root>\apps\<name>\current` is the junction scoop points the shims at, so it is both the
        // real location and the one that stays correct across the next version bump.
        const location = await firstExisting(
          roots.flatMap((root) => [safeJoin(root, 'apps', name, 'current'), safeJoin(root, 'apps', name)]),
        );

        const item = buildItem({
          provider: 'scoop',
          id: name,
          current: installed ?? '',
          available: latest,
          source: 'bucket',
          location,
        });
        if (item) items.push(item);
      }
    }

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    return run(rt, info.binary!, ['update', item.id]);
  },
};
