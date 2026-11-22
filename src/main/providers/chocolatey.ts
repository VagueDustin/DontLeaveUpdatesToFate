/**
 * Chocolatey.
 *
 * The only provider with a genuinely machine-readable outdated format:
 * `choco outdated --limit-output` prints `name|current|available|pinned` per line.
 *
 * It also prints unrelated chatter to the same stream, on this machine, a self-update warning
 * ("Access to the path 'choco.exe.old' is denied") and "This is try 1/3." retry lines appear before
 * the data. So rows are matched by shape rather than by position.
 */

import type { UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ancestorOf, dirExists, safeJoin } from '../paths.js';
import { buildItem, locate, probeVersion, run, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider } from './types.js';

/**
 * Where Chocolatey keeps its package folders.
 *
 * `%ChocolateyInstall%` is the documented answer, but it is set at MACHINE scope by the installer and
 * this process may well have started before that happened, or been relaunched elevated into a
 * different environment block. Walking up from the resolved binary
 * (`…\chocolatey\bin\choco.exe`) is the fallback that always works.
 */
export function chocolateyRoot(binary: string | null): string | null {
  const declared = process.env.ChocolateyInstall?.trim();
  if (declared) return declared.replace(/[\\/]+$/, '');
  if (!binary) return null;
  return ancestorOf(binary, 2);
}

/** The Add/Remove Programs names recorded in one of Chocolatey's `.registry` snapshots. */
export function snapshotDisplayNames(xml: string): string[] {
  const decode = (text: string): string =>
    text.replace(/&(amp|quot|apos|lt|gt);/g, (_, e: string) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[e]!);
  return [...xml.matchAll(/\bdisplayName="([^"]*)"/g)].map((m) => decode(m[1]!).trim()).filter(Boolean);
}

/**
 * A program's name with the patch number dropped: `Python 3.13.16 (64-bit)` and
 * `Python 3.13.17 (64-bit)` are one program, `Python 3.14.8 (64-bit)` is another.
 *
 * Needed because a snapshot is only written when an install changes the registry. Python 3.13.17
 * arrived through winget first, Chocolatey's own upgrade then found nothing to change and recorded
 * nothing, and an exact-name match would have lost the pairing for good.
 */
export function programKey(name: string): string {
  return name.trim().toLowerCase().replace(/(\d+\.\d+)(?:\.\d+)+/g, '$1');
}

/**
 * The programs Chocolatey installed, as `programKey` of the Add/Remove Programs name to package id.
 *
 * winget lists every program in Add/Remove Programs, whoever put it there, so a Python or Visual
 * Studio that Chocolatey installed is offered twice. Chocolatey writes down the registry entries each
 * install created, in `<root>\.chocolatey\<id>.<version>\.registry`, and that record is the only
 * dependable link between the two rows: package ids and names do not match across catalogues.
 * Only packages still in `lib` count, since a snapshot outlives the package it was taken for.
 */
export async function readChocolateyInstalls(root: string | null): Promise<Map<string, string>> {
  const owned = new Map<string, string>();
  if (!root) return owned;
  try {
    const ids = await readdir(join(root, 'lib'));
    for (const dir of await readdir(join(root, '.chocolatey'))) {
      // `python313.3.13.16` belongs to `python313`: the id, a dot, then a version.
      const id = ids.find(
        (candidate) =>
          dir.toLowerCase().startsWith(`${candidate.toLowerCase()}.`) && /^\d/.test(dir.slice(candidate.length + 1)),
      );
      if (!id) continue;
      const xml = await readFile(join(root, '.chocolatey', dir, '.registry'), 'utf8').catch(() => '');
      for (const name of snapshotDisplayNames(xml)) owned.set(programKey(name), id);
    }
  } catch {
    /* no Chocolatey, or a root this process cannot read: nothing is owned */
  }
  return owned;
}

/** `name|current|available|pinned`, four fields, last one a boolean. */
const ROW = /^([^|]+)\|([^|]*)\|([^|]+)\|(true|false)\s*$/i;

/** Pure row parser, exercised by unit tests against captured `choco outdated` output. */
export function parseChocoOutdated(
  lines: string[],
  locateBy: (id: string) => string | null = () => null,
): UpdateItem[] {
  const items: UpdateItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = ROW.exec(line);
    if (!match) continue;

    const [, name, current, available, pinned] = match;
    const item = buildItem({
      provider: 'chocolatey',
      id: name!,
      current: current ?? '',
      available: available!,
      pinned: pinned!.toLowerCase() === 'true',
      location: locateBy(name!.trim()),
    });
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  return items;
}

export const chocolateyProvider: Provider = {
  id: 'chocolatey',
  label: 'Chocolatey',
  command: 'choco',
  kind: 'system',
  blurb: 'Machine-wide packages from the Chocolatey community repository.',
  needsElevation: true,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('choco');
    if (!binary) return NOT_FOUND('choco');

    const version = await probeVersion(binary, ['--version'], timeoutMs);
    if (version === null) {
      return {
        available: false,
        binary,
        version: null,
        unavailable: 'incapable',
        unavailableDetail: 'choco is on PATH but did not report a version.',
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

    const result = await run(rt, info.binary, [
      'outdated',
      '--limit-output',
      '--no-progress',
      '--ignore-unfound',
    ]);

    /*
      Package folders are `<root>\lib\<id>`. Every candidate is confirmed on disk before it is
      offered: a package installed by a different tool, or one choco tracks under a differently-cased
      id, must show no location rather than a path that is not there.
    */
    const root = chocolateyRoot(info.binary);
    const candidates = new Map<string, string>();
    if (root) {
      const ids = new Set(
        result.lines.map((line) => ROW.exec(line)?.[1]?.trim()).filter((id): id is string => !!id),
      );
      await Promise.all(
        [...ids].map(async (id) => {
          const path = safeJoin(root, 'lib', id);
          if (path && (await dirExists(path))) candidates.set(id, path);
        }),
      );
    }

    const items = parseChocoOutdated(result.lines, (id) => candidates.get(id) ?? null);
    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    // No --limit-output here: for an upgrade the full transcript is the point.
    return run(rt, info.binary!, [
      'upgrade',
      item.id,
      '--yes',
      '--no-progress',
      '--accept-license',
    ]);
  },
};
