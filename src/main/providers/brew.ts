/**
 * brew.ts: Homebrew formulae (command-line tools) and casks (apps), as two providers.
 *
 * They share one binary but behave differently enough to be separate rows in the sidebar: casks can
 * update themselves, can need an administrator password (pkg installers), and close the app they
 * replace. Formulae never need root, and brew refuses to run as root anyway.
 */

import type { UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { firstExisting, safeJoin } from '../paths.js';
import { platform } from '../platform/index.js';
import { extractFirstJson } from '../text.js';
import { buildItem, locate, probeVersion, run, runQuiet, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider, type ProviderRuntime } from './types.js';

/** Every brew call: no self-update mid-scan, no hint lines in the transcript, no surprise cleanup. */
export const BREW_ENV: NodeJS.ProcessEnv = {
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
  HOMEBREW_NO_INSTALL_CLEANUP: '1',
};

export interface BrewRow {
  name: string;
  installed: string;
  available: string;
  pinned: boolean;
}

interface RawEntry {
  name?: unknown;
  installed_versions?: unknown;
  current_version?: unknown;
  pinned?: unknown;
}

function toRow(raw: RawEntry): BrewRow | null {
  if (typeof raw.name !== 'string' || typeof raw.current_version !== 'string') return null;
  // Formulae list every installed version (oldest first); casks used to give a bare string.
  const versions = Array.isArray(raw.installed_versions)
    ? raw.installed_versions.filter((v): v is string => typeof v === 'string')
    : typeof raw.installed_versions === 'string'
      ? [raw.installed_versions]
      : [];
  return {
    name: raw.name,
    installed: versions.at(-1) ?? '',
    available: raw.current_version,
    pinned: raw.pinned === true,
  };
}

/** Parse `brew outdated --json=v2`, reading from the first `{` past any progress lines. */
export function parseBrewOutdated(text: string): { formulae: BrewRow[]; casks: BrewRow[] } {
  const empty = { formulae: [], casks: [] };
  const json = extractFirstJson(text);
  if (!json) return empty;
  let data: { formulae?: unknown; casks?: unknown };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return empty;
  }
  const rows = (list: unknown): BrewRow[] =>
    Array.isArray(list) ? list.map((r) => toRow(r as RawEntry)).filter((r): r is BrewRow => r !== null) : [];
  return { formulae: rows(data.formulae), casks: rows(data.casks) };
}

/** Map cask token to its installed .app path, from `brew info --cask --json=v2`. */
export function caskAppPaths(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const json = extractFirstJson(text);
  if (!json) return out;
  try {
    const data = JSON.parse(json) as { casks?: Array<{ token?: string; artifacts?: unknown[] }> };
    for (const cask of data.casks ?? []) {
      for (const artifact of cask.artifacts ?? []) {
        const target = (artifact as { target?: unknown }).target;
        if (cask.token && typeof target === 'string' && target.endsWith('.app')) {
          out.set(cask.token, target);
          break;
        }
      }
    }
  } catch {
    /* no paths, rows show a dash */
  }
  return out;
}

async function probeBrew(timeoutMs: number): Promise<ProbeResult> {
  const binary = await locate('brew');
  if (!binary) return NOT_FOUND('brew');
  const version = await probeVersion(binary, ['--version'], timeoutMs);
  if (version === null) {
    return {
      available: false,
      binary,
      version: null,
      unavailable: 'incapable',
      unavailableDetail: 'brew is on PATH but did not report a version.',
      environments: [],
    };
  }
  return { available: true, binary, version, unavailable: null, unavailableDetail: null, environments: [] };
}

async function scanBrew(binary: string, kind: 'formula' | 'cask', rt: ProviderRuntime) {
  const args = ['outdated', `--${kind}`, '--json=v2'];
  if (kind === 'cask' && rt.options.includeSelfUpdatingApps) args.push('--greedy');
  const result = await run(rt, binary, args, { echoOutput: false, extraEnv: BREW_ENV });
  const parsed = parseBrewOutdated(result.stdout);
  return { result, rows: kind === 'formula' ? parsed.formulae : parsed.casks };
}

function finish(result: CommandResult, items: UpdateItem[]): UpdateItem[] {
  const failure = scanFailed(result, items.length);
  if (failure) throw new Error(failure);
  return items;
}

export const brewFormulaProvider: Provider = {
  id: 'brew',
  label: 'Homebrew',
  command: 'brew',
  kind: 'system',
  blurb: 'Command-line tools installed with Homebrew.',
  needsElevation: false,

  probe: probeBrew,

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const { result, rows } = await scanBrew(info.binary, 'formula', rt);
    const prefix = (await runQuiet(rt, info.binary, ['--prefix'])).stdout.trim() || '/opt/homebrew';

    const items: UpdateItem[] = [];
    for (const row of rows) {
      const location = await firstExisting([
        safeJoin(`${prefix}/Cellar`, row.name, row.installed),
        safeJoin(`${prefix}/Cellar`, row.name),
      ]);
      const item = buildItem({
        provider: 'brew',
        id: row.name,
        current: row.installed,
        available: row.available,
        pinned: row.pinned,
        location,
      });
      if (item) items.push(item);
    }
    return finish(result, items);
  },

  upgrade: (item, info, rt) => run(rt, info.binary!, ['upgrade', '--formula', item.id], { extraEnv: BREW_ENV }),
};

export const brewCaskProvider: Provider = {
  id: 'brew-cask',
  label: 'Homebrew apps',
  command: 'brew',
  kind: 'system',
  blurb: 'Apps installed with Homebrew casks. Updating an app closes it first.',
  needsElevation: false,

  probe: probeBrew,

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const { result, rows } = await scanBrew(info.binary, 'cask', rt);
    const paths =
      rows.length > 0
        ? caskAppPaths(
            (await runQuiet(rt, info.binary, ['info', '--cask', '--json=v2', ...rows.map((r) => r.name)])).stdout,
          )
        : new Map<string, string>();

    const items: UpdateItem[] = [];
    for (const row of rows) {
      const item = buildItem({
        provider: 'brew-cask',
        id: row.name,
        current: row.installed,
        available: row.available,
        location: paths.get(row.name) ?? null,
      });
      if (item) items.push(item);
    }
    return finish(result, items);
  },

  upgrade(item, info, rt) {
    // pkg-based casks call sudo; with SUDO_ASKPASS set, that shows the native password dialog instead
    // of waiting forever on a terminal prompt nobody can see.
    const elevation = platform.elevation;
    const askpass = elevation.kind === 'askpass' ? { SUDO_ASKPASS: elevation.askpassPath() } : {};
    return run(rt, info.binary!, ['upgrade', '--cask', item.id], { extraEnv: { ...BREW_ENV, ...askpass } });
  },
};
