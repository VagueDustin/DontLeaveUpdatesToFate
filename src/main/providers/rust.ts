/**
 * rustup toolchains and cargo-installed binaries.
 *
 * `rustup check` is one of the few Windows CLIs with output that is both stable and easy to read, so
 * this provider is fully verified against real output from the build machine:
 *
 *   stable-x86_64-pc-windows-msvc - update available: 1.95.0 (59807616e 2026-04-14) -> 1.97.1 (…)
 *   rustup - up to date : 1.29.0
 *
 * cargo is different: plain cargo cannot tell you whether an installed binary is out of date. That
 * needs the `cargo-update` subcommand crate. Rather than silently reporting "nothing to do", the
 * provider reports itself as present-but-incapable and names the one command that fixes it.
 */

import { join } from 'node:path';
import type { UpdateItem } from '../../shared/types.js';
import type { CommandResult } from '../exec.js';
import { ancestorOf, firstExisting, homeDir, safeJoin } from '../paths.js';
import { parseTables } from '../table.js';
import { buildItem, locate, probeVersion, run, runQuiet, scanFailed } from './util.js';
import { NOT_FOUND, type ProbeResult, type Provider } from './types.js';

/** `%RUSTUP_HOME%`, or the `.rustup` beside the profile that rustup creates by default. */
export function rustupHome(): string {
  return (process.env.RUSTUP_HOME?.trim() || join(homeDir(), '.rustup')).replace(/[\/]+$/, '');
}

/** `%CARGO_HOME%`, or `~/.cargo`. Walking up from the binary covers a relocated install. */
export function cargoHome(binary: string | null): string {
  const declared = process.env.CARGO_HOME?.trim();
  if (declared) return declared.replace(/[\/]+$/, '');
  if (binary) return ancestorOf(binary, 2);
  return join(homeDir(), '.cargo');
}

// ── rustup ────────────────────────────────────────────────────────────────────────────────────

/** `<name> - update available: <from> -> <to>` */
const RUSTUP_ROW = /^(\S+)\s+-\s+update available\s*:\s*(.+?)\s*->\s*(.+?)\s*$/;

/** rustup appends a commit hash and date: "1.95.0 (59807616e 2026-04-14)". Keep just the version. */
function bareVersion(text: string): string {
  return text.trim().split(/\s+/)[0] ?? text.trim();
}

export function parseRustupCheck(lines: string[]): Array<{
  id: string;
  current: string;
  available: string;
}> {
  const out: Array<{ id: string; current: string; available: string }> = [];
  for (const line of lines) {
    const match = RUSTUP_ROW.exec(line.trim());
    if (!match) continue;
    out.push({
      id: match[1]!,
      current: bareVersion(match[2]!),
      available: bareVersion(match[3]!),
    });
  }
  return out;
}

export const rustupProvider: Provider = {
  id: 'rustup',
  label: 'rustup',
  command: 'rustup',
  kind: 'toolchain',
  blurb: 'Rust toolchains and the rustup installer itself.',
  needsElevation: false,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('rustup');
    if (!binary) return NOT_FOUND('rustup');

    const version = await probeVersion(binary, ['--version'], timeoutMs);
    if (version === null) {
      return {
        available: false,
        binary,
        version: null,
        unavailable: 'incapable',
        unavailableDetail: 'rustup is on PATH but did not report a version.',
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

    const result = await run(rt, info.binary, ['check']);
    const items: UpdateItem[] = [];
    const home = rustupHome();

    for (const row of parseRustupCheck(result.lines)) {
      // The `rustup` row is the installer updating itself, which lives in the cargo bin directory
      // alongside every shim; a toolchain row is a directory under the rustup home.
      const location =
        row.id === 'rustup'
          ? await firstExisting([cargoHome(info.binary), join(home, 'bin')])
          : await firstExisting([safeJoin(home, 'toolchains', row.id)]);

      const item = buildItem({
        provider: 'rustup',
        id: row.id,
        current: row.current,
        available: row.available,
        source: row.id === 'rustup' ? 'installer' : 'toolchain',
        location,
      });
      if (item) items.push(item);
    }

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    // rustup updates itself through a different verb than it updates toolchains.
    const args = item.id === 'rustup' ? ['self', 'update'] : ['update', item.id];
    return run(rt, info.binary!, args);
  },
};

// ── cargo ─────────────────────────────────────────────────────────────────────────────────────

const CARGO_HEADERS = ['Package', 'Installed', 'Latest', 'Needs update'];

export const cargoProvider: Provider = {
  id: 'cargo',
  label: 'cargo',
  command: 'cargo',
  kind: 'language',
  blurb: 'Binaries installed with cargo install. Requires the cargo-update subcommand.',
  needsElevation: false,

  async probe(timeoutMs): Promise<ProbeResult> {
    const binary = await locate('cargo');
    if (!binary) return NOT_FOUND('cargo');

    const version = await probeVersion(binary, ['--version'], timeoutMs);
    if (version === null) {
      return {
        available: false,
        binary,
        version: null,
        unavailable: 'incapable',
        unavailableDetail: 'cargo is on PATH but did not report a version.',
        environments: [],
      };
    }

    // The capability probe: plain cargo has no notion of "outdated".
    const hasUpdate = await probeVersion(binary, ['install-update', '--version'], timeoutMs);
    if (hasUpdate === null) {
      return {
        available: false,
        binary,
        version,
        unavailable: 'incapable',
        unavailableDetail:
          'cargo cannot report outdated binaries on its own. Install the subcommand with: cargo install cargo-update',
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

    const result = await run(rt, info.binary, ['install-update', '--list']);
    const items: UpdateItem[] = [];
    // Everything `cargo install` produces is a binary in one directory, so it is resolved once.
    const bin = await firstExisting([join(cargoHome(info.binary), 'bin')]);

    for (const table of parseTables(result.lines, { labels: CARGO_HEADERS })) {
      for (const cells of table.rows) {
        const [name, installed, latest, needs] = cells;
        if (!name || !latest) continue;
        if (!/^yes$/i.test(needs?.trim() ?? '')) continue;

        const item = buildItem({
          provider: 'cargo',
          id: name,
          // cargo-update prefixes versions with "v".
          current: (installed ?? '').replace(/^v/, ''),
          available: latest.replace(/^v/, ''),
          source: 'crates.io',
          location: bin,
        });
        if (item) items.push(item);
      }
    }

    const failure = scanFailed(result, items.length);
    if (failure) throw new Error(failure);
    return items;
  },

  async upgrade(item, info, rt): Promise<CommandResult> {
    return run(rt, info.binary!, ['install-update', item.id]);
  },
};

/** Exported so the smoke test can confirm `cargo install --list` is reachable at all. */
export async function cargoHasInstalledBinaries(
  rt: Parameters<typeof runQuiet>[0],
  binary: string,
): Promise<boolean> {
  const result = await runQuiet(rt, binary, ['install', '--list']);
  return result.lines.some((line) => /^\S/.test(line));
}
