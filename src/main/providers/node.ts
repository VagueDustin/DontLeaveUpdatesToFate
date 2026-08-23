/**
 * npm and pnpm global packages.
 *
 * Both print the same shape from `outdated --json` — an object keyed by package name — so they share
 * one parser and live in one file rather than duplicating it.
 *
 * Two quirks are handled here:
 *  - `outdated` exits 1 when it finds something. That is success, not failure; `scanFailed` only
 *    reports an error when nothing was parsed.
 *  - npm sometimes gives an ARRAY as the value when several versions of a package are installed in
 *    different places. Taking the first entry is correct for `-g`, where there is only one root.
 */

import { isAbsolute } from 'node:path';
import type { ProviderId, UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { safeJoin } from '../paths.js';
import { parseLooseJson } from '../text.js';
import { buildItem, locate, probeVersion, run, runQuiet, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider, type ProviderRuntime } from './types.js';

interface OutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  location?: string;
}

type OutdatedReport = Record<string, OutdatedEntry | OutdatedEntry[]>;

/**
 * `globalRoot` is the fallback for the `location` field.
 *
 * npm fills `location` in itself — it is the one manager that hands over the answer for free — but
 * pnpm's `outdated --json` has no such field, so the global store root is queried once and the
 * package name appended. A scoped name (`@scope/pkg`) is split so the two path segments are validated
 * separately.
 */
function parseOutdated(
  provider: ProviderId,
  stdout: string,
  globalRoot: string | null = null,
): UpdateItem[] {
  const report = parseLooseJson<OutdatedReport>(stdout);
  if (!report || typeof report !== 'object') return [];

  const items: UpdateItem[] = [];

  for (const [name, raw] of Object.entries(report)) {
    const entry = Array.isArray(raw) ? raw[0] : raw;
    if (!entry) continue;

    // `latest` is the real target; `wanted` is range-constrained and meaningless for a global install.
    const available = entry.latest ?? entry.wanted;
    if (!available) continue;

    const reported = entry.location?.trim();
    const location =
      reported && isAbsolute(reported)
        ? reported
        : globalRoot
          ? safeJoin(globalRoot, ...name.split('/'))
          : null;

    const item = buildItem({
      provider,
      id: name,
      current: entry.current ?? '',
      available,
      source: 'global',
      location,
    });
    if (item) items.push(item);
  }
  return items;
}

async function probeNodeManager(command: string, timeoutMs: number): Promise<ProbeResult> {
  const binary = await locate(command);
  if (!binary) return NOT_FOUND(command);

  const version = await probeVersion(binary, ['--version'], timeoutMs);
  if (version === null) {
    return {
      available: false,
      binary,
      version: null,
      unavailable: 'incapable',
      unavailableDetail: `${command} is on PATH but did not report a version.`,
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
}

export const npmProvider: Provider = {
  id: 'npm',
  label: 'npm (global)',
  command: 'npm',
  kind: 'language',
  blurb: 'Globally installed Node packages and CLI tools.',
  needsElevation: false,

  probe: (timeoutMs) => probeNodeManager('npm', timeoutMs),

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];

    const [result, root] = await Promise.all([
      run(rt, info.binary, ['outdated', '--global', '--json'], { echoOutput: false }),
      globalRootOf(rt, info.binary, ['root', '--global']),
    ]);
    const items = parseOutdated('npm', result.stdout, root);

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    // `npm update -g` refuses to cross a major boundary; an explicit @latest install does not.
    return run(rt, info.binary!, ['install', '--global', `${item.id}@latest`]);
  },
};

export const pnpmProvider: Provider = {
  id: 'pnpm',
  label: 'pnpm (global)',
  command: 'pnpm',
  kind: 'language',
  blurb: 'Globally installed packages in the pnpm store.',
  needsElevation: false,

  probe: (timeoutMs) => probeNodeManager('pnpm', timeoutMs),

  async scan(info, rt): Promise<UpdateItem[]> {
    if (!info.binary) return [];

    const [result, root] = await Promise.all([
      run(rt, info.binary, ['outdated', '--global', '--json'], { echoOutput: false }),
      globalRootOf(rt, info.binary, ['root', '--global']),
    ]);
    const items = parseOutdated('pnpm', result.stdout, root);

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    return run(rt, info.binary!, ['add', '--global', `${item.id}@latest`]);
  },
};

/**
 * Ask a Node package manager where its global `node_modules` is.
 *
 * Quiet and failure-tolerant: this is decoration on the row, and a manager that will not answer must
 * cost nothing. The check that the reply is an absolute path matters because both tools print advisory
 * text on the same stream when something is misconfigured.
 */
async function globalRootOf(
  rt: ProviderRuntime,
  binary: string,
  args: string[],
): Promise<string | null> {
  try {
    const result = await runQuiet(rt, binary, args, Math.min(rt.timeoutMs, 20_000));
    if (result.code !== 0) return null;
    const line = result.stdout.trim().split('\n')[0]?.trim() ?? '';
    return line.length > 0 && isAbsolute(line) ? line : null;
  } catch {
    return null;
  }
}

/** Exported for unit tests against captured real output. */
export const __test = { parseOutdated };

export type { ProviderRuntime };
