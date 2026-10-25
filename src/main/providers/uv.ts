/**
 * uv.ts: tools installed with `uv tool install`, and the Pythons uv manages.
 *
 * Only uv-managed Pythons are offered. A system or Homebrew Python can appear in `uv python list`, but
 * uv does not own it and `uv python upgrade` would install a new copy beside it rather than update it.
 */

import { posix } from 'node:path';

import type { UpdateItem } from '../../shared/types.js';
import { compareVersions } from '../text.js';
import { buildItem, locate, probeVersion, run, runQuiet, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider } from './types.js';

export interface UvToolRow {
  name: string;
  installed: string;
  available: string;
}

/** `ruff v0.14.0 [latest: 0.17.2]`, followed by `- ruff` entry-point lines that are not tools. */
export function parseUvToolOutdated(text: string): UvToolRow[] {
  const rows: UvToolRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+) v(\S+) \[latest: ([^\]\s]+)\]/.exec(line.trim());
    if (m) rows.push({ name: m[1]!, installed: m[2]!, available: m[3]! });
  }
  return rows;
}

export interface UvPython {
  /** The full key, e.g. `cpython-3.12.14-macos-aarch64-none`. */
  key: string;
  implementation: string;
  version: string;
  /** Build variant after the version, e.g. `+freethreaded`; empty for the default build. */
  variant: string;
  platform: string;
  /** Interpreter path, or null for a download that is not installed. */
  path: string | null;
  managed: boolean;
}

/** Parse `uv python list` output (installed paths, or `<download available>`). */
export function parseUvPythonList(text: string, pythonDir: string): UvPython[] {
  const out: UvPython[] = [];
  for (const line of text.split('\n')) {
    const m = /^([a-z]+)-(\d+\.\d+\.\d+(?:[a-z]+\d+)?)(\+[a-z]+)?-(\S+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const location = m[5]!.trim();
    const path = location.startsWith('<') ? null : location.replace(/\s+->\s+.*$/, '');
    out.push({
      key: `${m[1]}-${m[2]}${m[3] ?? ''}-${m[4]}`,
      implementation: m[1]!,
      version: m[2]!,
      variant: m[3] ?? '',
      platform: m[4]!,
      path,
      managed: path !== null && path.startsWith(pythonDir.replace(/\/$/, '') + '/'),
    });
  }
  return out;
}

export interface UvPythonUpgrade {
  minor: string;
  installed: string;
  available: string;
  path: string | null;
}

const minorOf = (version: string): string => version.split('.').slice(0, 2).join('.');
const isPrerelease = (version: string): boolean => /[a-z]/i.test(version);

/** For each managed install, the newest stable download of the same implementation, minor and build. */
export function newestPatchPerMinor(installed: UvPython[], downloads: UvPython[]): UvPythonUpgrade[] {
  const upgrades: UvPythonUpgrade[] = [];
  for (const have of installed) {
    if (!have.managed) continue;
    let best: string | null = null;
    for (const d of downloads) {
      if (d.implementation !== have.implementation || d.variant !== have.variant || d.platform !== have.platform) continue;
      if (minorOf(d.version) !== minorOf(have.version) || isPrerelease(d.version)) continue;
      if (best === null || (compareVersions(d.version, best) ?? 0) > 0) best = d.version;
    }
    if (best && (compareVersions(best, have.version) ?? 0) > 0) {
      upgrades.push({ minor: minorOf(have.version), installed: have.version, available: best, path: have.path });
    }
  }
  return upgrades;
}

async function probeUv(timeoutMs: number): Promise<ProbeResult> {
  const binary = await locate('uv');
  if (!binary) return NOT_FOUND('uv');
  const version = await probeVersion(binary, ['--version'], timeoutMs);
  if (version === null) {
    return {
      available: false,
      binary,
      version: null,
      unavailable: 'incapable',
      unavailableDetail: 'uv is on PATH but did not report a version.',
      environments: [],
    };
  }
  return { available: true, binary, version, unavailable: null, unavailableDetail: null, environments: [] };
}

export const uvToolProvider: Provider = {
  id: 'uv-tool',
  label: 'uv tools',
  command: 'uv',
  kind: 'language',
  blurb: 'Command-line tools installed with uv tool install.',
  needsElevation: false,

  probe: probeUv,

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const [result, dir] = await Promise.all([
      run(rt, info.binary, ['tool', 'list', '--outdated'], { echoOutput: false }),
      runQuiet(rt, info.binary, ['tool', 'dir']),
    ]);
    const root = dir.stdout.trim();
    const items: UpdateItem[] = [];
    for (const row of parseUvToolOutdated(result.stdout)) {
      const item = buildItem({
        provider: 'uv-tool',
        id: row.name,
        current: row.installed,
        available: row.available,
        location: root ? posix.join(root, row.name) : null,
      });
      if (item) items.push(item);
    }
    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  upgrade: (item, info, rt) => run(rt, info.binary!, ['tool', 'upgrade', item.id]),
};

export const uvPythonProvider: Provider = {
  id: 'uv-python',
  label: 'uv Pythons',
  command: 'uv',
  kind: 'toolchain',
  blurb: 'Python versions installed and managed by uv. Updates move to the newest patch release.',
  needsElevation: false,

  probe: probeUv,

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];
    const [installedRun, downloadsRun, dir] = await Promise.all([
      run(rt, info.binary, ['python', 'list', '--only-installed'], { echoOutput: false }),
      runQuiet(rt, info.binary, ['python', 'list', '--only-downloads']),
      runQuiet(rt, info.binary, ['python', 'dir']),
    ]);
    const pythonDir = dir.stdout.trim();
    const upgrades = newestPatchPerMinor(
      parseUvPythonList(installedRun.stdout, pythonDir),
      parseUvPythonList(downloadsRun.stdout, pythonDir),
    );
    const items: UpdateItem[] = [];
    for (const u of upgrades) {
      const item = buildItem({
        provider: 'uv-python',
        id: u.minor,
        name: `Python ${u.minor}`,
        current: u.installed,
        available: u.available,
        // .../cpython-3.12-macos-aarch64-none/bin/python3.12 -> the install folder
        location: u.path ? posix.dirname(posix.dirname(u.path)) : null,
      });
      if (item) items.push(item);
    }
    const failure = scanFailed(installedRun, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  upgrade: (item, info, rt) => run(rt, info.binary!, ['python', 'upgrade', item.id]),
};
