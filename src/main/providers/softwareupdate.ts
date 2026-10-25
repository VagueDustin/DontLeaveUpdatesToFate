/**
 * softwareupdate.ts: macOS system updates (macOS itself, Safari, security responses).
 *
 * Installing always needs root. The command runs through `sudo -A`, so sudo asks the bundled askpass
 * helper, which shows the standard macOS password dialog. The app never restarts the Mac: updates that
 * need one carry a Restart chip, and run last in Update all.
 */

import type { UpdateItem } from '../../shared/types.js';
import { pathExists } from '../paths.js';
import { platform } from '../platform/index.js';
import { buildItem, run, scanFailed } from './util.js';
import type { ProbeResult, Provider } from './types.js';

const SOFTWAREUPDATE = '/usr/sbin/softwareupdate';
const SUDO = '/usr/bin/sudo';

export interface SoftwareUpdateRow {
  label: string;
  title: string;
  version: string;
  restart: boolean;
}

/**
 * `* Label: macOS Tahoe 26.7.1-25G241` followed by
 * `\tTitle: macOS Tahoe 26.7.1, Version: 26.7.1, Size: 2960823KiB, Recommended: YES, Action: restart,`
 */
export function parseSoftwareUpdateList(text: string): SoftwareUpdateRow[] {
  const rows: SoftwareUpdateRow[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const label = /^\*\s*Label:\s*(.+?)\s*$/.exec(lines[i]!)?.[1];
    if (!label) continue;
    const details = lines[i + 1] ?? '';
    const field = (name: string): string | null => new RegExp(`${name}:\\s*([^,]+)`).exec(details)?.[1]?.trim() ?? null;
    rows.push({
      label,
      title: field('Title') ?? label,
      version: field('Version') ?? '',
      restart: /Action:\s*restart/i.test(details),
    });
  }
  return rows;
}

/** The dialog text, reduced to characters the argument filter accepts (sudo also expands `%`). */
export function sudoPrompt(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 .-]/g, '').replace(/\s+/g, ' ').trim();
  return `Enter your administrator password to install ${clean}.`;
}

/** sudo's own wording when the password dialog was cancelled or left empty. */
export function sudoDeclined(text: string): boolean {
  return /no password was provided|a password is required|incorrect password attempt/i.test(text);
}

export const softwareUpdateProvider: Provider = {
  id: 'softwareupdate',
  label: 'macOS updates',
  command: 'softwareupdate',
  kind: 'system',
  blurb: 'macOS, Safari and security updates from Apple. Installing asks for your administrator password.',
  needsElevation: true,

  async probe(): Promise<ProbeResult> {
    const present = await pathExists(SOFTWAREUPDATE);
    return present
      ? { available: true, binary: SOFTWAREUPDATE, version: null, unavailable: null, unavailableDetail: null, environments: [] }
      : {
          available: false,
          binary: null,
          version: null,
          unavailable: 'missing',
          unavailableDetail: 'softwareupdate is not on this system.',
          environments: [],
        };
  },

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const result = await run(rt, info.binary, ['--list']);
    const items: UpdateItem[] = [];
    for (const row of parseSoftwareUpdateList(`${result.stdout}\n${result.stderr}`)) {
      const item = buildItem({
        provider: 'softwareupdate',
        id: row.label,
        name: row.title,
        // softwareupdate does not report the installed version; the row shows "Unknown".
        current: '',
        available: row.version || row.label,
        source: row.restart ? 'restart' : null,
        allowSpaces: true,
      });
      if (item) items.push({ ...item, uncertain: false });
    }
    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt) {
    const elevation = platform.elevation;
    const askpass = elevation.kind === 'askpass' ? elevation.askpassPath() : '';
    const result = await run(
      rt,
      SUDO,
      ['-A', '-p', sudoPrompt(item.name), info.binary!, '--install', item.id],
      { extraEnv: { SUDO_ASKPASS: askpass } },
    );
    if (elevation.kind === 'askpass') elevation.recordPrompt(sudoDeclined(`${result.stderr}\n${result.stdout}`));
    return result;
  },
};
