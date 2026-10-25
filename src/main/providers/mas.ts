/**
 * mas.ts: Mac App Store apps, through the free `mas` command-line tool.
 *
 * `mas` only updates apps for the Apple Account signed in to the App Store, and it is not installed by
 * default; the sidebar offers to install it with Homebrew when it is missing.
 */

import type { UpdateItem } from '../../shared/types.js';
import { runCommand } from '../exec.js';
import { firstExisting } from '../paths.js';
import { platform } from '../platform/index.js';
import { sudoDeclined, sudoPrompt } from './softwareupdate.js';
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

/**
 * How to update one app. mas 7 and later need root to update apps ("Requires root privileges"), and
 * when they ask sudo themselves there is no terminal and no askpass flag, so the update fails. Running
 * them through `sudo -A` instead shows the standard macOS password dialog via the bundled helper.
 */
export function masUpgradeCommand(
  version: string | null,
  binary: string,
  id: string,
  name: string,
): { file: string; args: string[]; elevated: boolean } {
  const major = Number(/^(\d+)/.exec(version ?? '')?.[1] ?? 0);
  if (major >= 7) {
    return { file: '/usr/bin/sudo', args: ['-A', '-p', sudoPrompt(name), binary, 'upgrade', id], elevated: true };
  }
  return { file: binary, args: ['upgrade', id], elevated: false };
}

/** Spotlight query for an App Store app by its store id; the app's name can differ (Amazon Kindle). */
export function masLocationQuery(id: string): string[] {
  return [`kMDItemAppStoreAdamID == ${id}`];
}

async function masLocation(id: string, name: string, timeoutMs: number): Promise<string | null> {
  const found = await runCommand({ file: '/usr/bin/mdfind', args: masLocationQuery(id), timeoutMs });
  const app = found.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.app'));
  return app ?? (await firstExisting([`/Applications/${name}.app`]));
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
        location: await masLocation(row.id, row.name, 5_000),
      });
      if (item) items.push(item);
    }
    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt) {
    const command = masUpgradeCommand(info.version, info.binary!, item.id, item.name);
    const elevation = platform.elevation;
    const askpass = elevation.kind === 'askpass' ? { SUDO_ASKPASS: elevation.askpassPath() } : {};
    const result = await run(rt, command.file, command.args, { extraEnv: askpass });
    if (command.elevated && elevation.kind === 'askpass') {
      elevation.recordPrompt(sudoDeclined(`${result.stderr}\n${result.stdout}`));
    }
    return result;
  },
};
