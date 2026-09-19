/**
 * pip, Python packages, once per interpreter.
 *
 * This is the only multi-environment provider. A Windows box commonly has several Pythons (this one
 * has 3.14, 3.13 and 3.10), and "pip" on PATH is whichever happens to be first. Reporting only that
 * one would silently hide most of the machine, so every interpreter the launcher knows about is
 * enumerated and scanned, and each package is tagged with the interpreter it belongs to.
 *
 * Interpreters are always invoked as `<python.exe> -m pip` rather than through a `pip.exe` shim: the
 * shim hard-codes the interpreter path it was generated for and breaks after a Python upgrade, while
 * `-m pip` is correct by construction.
 */

import { homedir } from 'node:os';
import { normalize, sep } from 'node:path';
import type { ProviderEnvironment, UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { runCommand, type CommandResult as Result } from '../exec.js';
import { parseLooseJson } from '../text.js';
import { buildItem, locate, probeVersion, run, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider } from './types.js';

/**
 * Ask an interpreter where each installed distribution actually lives.
 *
 * Handed to `python -` on STDIN rather than `python -c "…"`, because the argument validator in
 * `exec.ts` refuses spaces and quotes (correctly) and a temp file would break on a username with a
 * space in it. One process per interpreter, 150-350ms each on this machine, versus the ~200 processes
 * `pip show` would need for the same answer.
 *
 * The candidate order matters. `torch` lists `functorch` first in its `top_level.txt`, so taking the
 * first entry reports the wrong folder; the distribution's own name is tried before the manifest, and
 * the manifest is sorted to put a matching entry first. A single-module distribution (`six.py`) has no
 * folder at all, and pointing at the file is more use than pointing at `site-packages`.
 */
const LOCATE_SCRIPT = `import json, os, sys
out = {}
try:
    from importlib.metadata import distributions
except Exception:
    distributions = None
if distributions is not None:
    for dist in distributions():
        try:
            name = (dist.metadata['Name'] or '').strip()
            if not name:
                continue
            key = name.lower().replace('_', '-').replace('.', '-')
            if key in out:
                continue
            info = getattr(dist, '_path', None)
            if info is None:
                continue
            base = os.path.dirname(str(info))
            norm = name.replace('-', '_')
            tops = []
            try:
                text = dist.read_text('top_level.txt') or ''
                tops = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith('_')]
            except Exception:
                pass
            tops.sort(key=lambda t: 0 if t.lower() == norm.lower() else 1)
            found = base
            for cand in [name, norm] + tops:
                full = os.path.join(base, cand)
                if os.path.isdir(full):
                    found = full
                    break
                if os.path.isfile(full + '.py'):
                    found = full + '.py'
                    break
            out[key] = found
        except Exception:
            pass
sys.stdout.write(json.dumps(out))
`;

/** pip's own normalisation, so `Pygments`, `typing_inspection` and `python.engineio` all key alike. */
export function distributionKey(name: string): string {
  return name.trim().toLowerCase().replace(/[_.]/g, '-');
}

/** Run the locator against one interpreter. Failure is silent, locations are decoration. */
async function readLocations(
  python: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    const result = await runCommand({
      file: python,
      args: ['-'],
      input: LOCATE_SCRIPT,
      timeoutMs: Math.min(timeoutMs, 45_000),
      // Cancelling a scan must take these with it: they are started for every interpreter at once and
      // would otherwise outlive the scan that asked for them.
      signal,
    });
    if (result.code !== 0) return found;
    const parsed = parseLooseJson<Record<string, unknown>>(result.stdout);
    if (!parsed || typeof parsed !== 'object') return found;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) found.set(distributionKey(key), value);
    }
  } catch {
    /* an interpreter that will not answer simply contributes no locations */
  }
  return found;
}

interface PipOutdated {
  name: string;
  version: string;
  latest_version: string;
  latest_filetype?: string;
}

/** `py -0p` prints ` -V:3.14 *        C:\Python314\python.exe` per installed interpreter. */
const LAUNCHER_ROW = /^\s*-V:(\S+)\s*\*?\s+(.+?)\s*$/;

export function parseLauncherList(lines: string[]): Array<{ tag: string; path: string }> {
  const found: Array<{ tag: string; path: string }> = [];
  for (const line of lines) {
    const match = LAUNCHER_ROW.exec(line);
    if (!match) continue;
    const tag = match[1]!;
    const path = match[2]!.trim();
    // Store-provided entries sometimes list no path at all.
    if (!path || !/\.exe$/i.test(path)) continue;
    found.push({ tag, path });
  }
  return found;
}

/**
 * An interpreter outside the user profile writes to a machine-wide `site-packages`, so upgrading it
 * needs an elevated process. Surfacing that in the label is cheaper than letting the user discover
 * it through an "Access is denied" traceback.
 */
function isSystemWide(path: string): boolean {
  const home = normalize(homedir()).toLowerCase();
  const target = normalize(path).toLowerCase();
  return !target.startsWith(home.endsWith(sep) ? home : home + sep);
}

async function pipWorks(python: string, timeoutMs: number): Promise<string | null> {
  const result: Result = await runCommand({
    file: python,
    args: ['-m', 'pip', '--version'],
    timeoutMs,
  });
  if (result.spawnFailed || result.code !== 0) return null;
  const match = result.stdout.match(/^pip\s+(\S+)/m);
  return match?.[1] ?? 'present';
}

export const pipProvider: Provider = {
  id: 'pip',
  label: 'pip',
  command: 'pip',
  kind: 'language',
  blurb: 'Python packages, listed separately for every interpreter on this machine.',
  needsElevation: false,

  async probe(timeoutMs): Promise<ProbeResult> {
    const candidates: Array<{ tag: string; path: string }> = [];

    // Preferred: ask the Python launcher, which knows about every registered install.
    const launcher = await locate('py');
    if (launcher) {
      const listed = await runCommand({ file: launcher, args: ['-0p'], timeoutMs });
      candidates.push(...parseLauncherList(listed.lines));
    }

    // Fall back to whatever `python` resolves to, and de-duplicate against the launcher results.
    if (candidates.length === 0) {
      const python = await locate('python');
      if (python) candidates.push({ tag: 'default', path: python });
    }

    if (candidates.length === 0) {
      const pip = await locate('pip');
      if (!pip) return NOT_FOUND('python');
      return {
        available: false,
        binary: pip,
        version: null,
        unavailable: 'incapable',
        unavailableDetail:
          'pip is on PATH but no Python interpreter could be located to run it through.',
        environments: [],
      };
    }

    // Probe interpreters concurrently: three sequential probes is a visible delay at startup.
    const probed = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        pipVersion: await pipWorks(candidate.path, timeoutMs),
      })),
    );

    const environments: ProviderEnvironment[] = [];
    const seenPaths = new Set<string>();

    for (const { candidate, pipVersion } of probed) {
      if (pipVersion === null) continue;
      const canonical = normalize(candidate.path).toLowerCase();
      if (seenPaths.has(canonical)) continue;
      seenPaths.add(canonical);

      environments.push({
        id: candidate.tag,
        label:
          candidate.tag === 'default'
            ? 'Python (default)'
            : `Python ${candidate.tag}${isSystemWide(candidate.path) ? ' · system' : ' · user'}`,
        path: candidate.path,
      });
    }

    if (environments.length === 0) {
      return {
        available: false,
        binary: candidates[0]!.path,
        version: null,
        unavailable: 'incapable',
        unavailableDetail:
          'Python is installed but none of its interpreters have a working pip module.',
        environments: [],
      };
    }

    const version = await probeVersion(environments[0]!.path, ['--version'], timeoutMs);

    return {
      available: true,
      // The "binary" for pip is the first interpreter; each scan uses its own environment path.
      binary: environments[0]!.path,
      version,
      unavailable: null,
      unavailableDetail: null,
      environments,
    };
  },

  async scan(info, rt): Promise<UpdateItem[]> {
    const environments = info.environments.length > 0 ? info.environments : [];
    if (environments.length === 0) return [];

    const items: UpdateItem[] = [];
    const failures: string[] = [];

    /*
      Locations are read for every interpreter up front and in parallel.
      Unlike the `pip list --outdated` calls below, this work is purely local (no PyPI round trip) so
      the reason those are serialised does not apply, and starting them now means the answers are
      already in hand by the time the first environment reports.
    */
    const locationsByEnv = new Map<string, Promise<Map<string, string>>>(
      environments.map((env) => [env.id, readLocations(env.path, rt.timeoutMs, rt.signal)]),
    );

    // Sequential on purpose: several pip processes hitting PyPI at once is slower in practice than
    // running them one after another, and it makes the terminal readout interleave unreadably.
    for (const env of environments) {
      if (rt.signal.aborted) break;

      rt.emit(`Reading ${env.label}`, 'system');
      const result = await run(rt, env.path, [
        '-m',
        'pip',
        'list',
        '--outdated',
        '--format=json',
        '--disable-pip-version-check',
      ], { echoOutput: false });

      const locations = (await locationsByEnv.get(env.id)) ?? new Map<string, string>();

      const parsed = parseLooseJson<PipOutdated[]>(result.stdout);
      let count = 0;

      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry?.name || !entry.latest_version) continue;
          const item = buildItem({
            provider: 'pip',
            environment: env.id,
            id: entry.name,
            current: entry.version ?? '',
            available: entry.latest_version,
            source: env.label,
            location: locations.get(distributionKey(entry.name)) ?? null,
          });
          if (item) {
            items.push(item);
            count++;
          }
        }
      }

      const failure = scanFailed(result, count);
      if (failure) failures.push(`${env.label}: ${failure}`);
      // Output is suppressed for this command (it is one huge JSON line), so report the tally here or
      // the transcript would show a command with no visible result.
      else rt.emit(`${env.label}: ${count} outdated`, count > 0 ? 'system' : 'success');
    }

    // Only a total failure is an error: one broken interpreter shouldn't discard the others.
    if (items.length === 0 && failures.length > 0) throw new Error(failures.join(' · '));
    for (const failure of failures) rt.emit(failure, 'warn');
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    const env = info.environments.find((e) => e.id === item.environment);
    const python = env?.path ?? info.binary!;
    return run(rt, python, ['-m', 'pip', 'install', '--upgrade', item.id]);
  },
};
