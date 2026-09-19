/**
 * providers/util.ts: helpers shared by every adapter.
 *
 * The important one is `run`: it logs the command line before executing so that an exported log
 * reads like a transcript someone could replay by hand, and it streams every output line straight
 * into the session log rather than buffering until the process exits.
 */

import type { UpdateItem, ProviderId } from '../../shared/types.js';
import {
  displayCommand,
  isSafePackageId,
  resolveBinary,
  runCommand,
  type CommandResult,
} from '../exec.js';
import { isRealUpgrade } from '../text.js';
import type { ProviderRuntime } from './types.js';

export interface RunOptions {
  /** Suppress both the command echo and the output. */
  quiet?: boolean;
  /**
   * Echo the command line but not its output.
   *
   * Used for scans that ask for `--json`: the payload is one enormous machine-readable line that
   * tells a reader nothing, while the command itself keeps the transcript replayable. Upgrades always
   * stream in full, that output is the whole point of the terminal pane.
   */
  echoOutput?: boolean;
  timeoutMs?: number;
}

/** Execute a provider command, echoing it and (by default) its output into the session log. */
export async function run(
  rt: ProviderRuntime,
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const { quiet = false, echoOutput = true, timeoutMs = rt.timeoutMs } = options;

  // Echo the command before running it, so an exported log reads as a transcript someone could
  // replay by hand rather than a wall of context-free output.
  if (!quiet) rt.emit(displayCommand(file, args), 'command');

  const streamLines = !quiet && echoOutput;

  const result = await runCommand({
    file,
    args,
    timeoutMs,
    signal: rt.signal,
    onLine: streamLines ? (line, stream) => rt.emitStream(line, stream) : undefined,
  });

  if (!quiet) {
    // Emitted after the run so the header can report the outcome alongside the command.
    if (result.timedOut) rt.emit(`Timed out after ${Math.round(timeoutMs / 1000)}s.`, 'error');
    else if (result.cancelled) rt.emit('Cancelled.', 'warn');
    // With output suppressed, a failure would otherwise be invisible in the transcript.
    else if (!echoOutput && result.code !== 0 && result.code !== null) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
      if (detail) rt.emit(detail, 'stderr');
    }
  }
  return result;
}

/** Run a command purely to capture its output, with nothing echoed to the log. */
export function runQuiet(
  rt: ProviderRuntime,
  file: string,
  args: string[],
  timeoutMs = rt.timeoutMs,
): Promise<CommandResult> {
  return run(rt, file, args, { quiet: true, timeoutMs });
}

/**
 * Ask a binary for its version, tolerating tools that print it to stderr.
 *
 * Returns null when the command fails, which is the signal that a binary exists on PATH but is not
 * usable, the case that matters for `dotnet`-style runtime-without-SDK installs.
 */
export async function probeVersion(
  file: string,
  args: string[],
  timeoutMs: number,
  extract: (text: string) => string | null = firstVersionLike,
): Promise<string | null> {
  const result = await runCommand({ file, args, timeoutMs });
  if (result.spawnFailed) return null;
  if (result.code !== 0) return null;
  return extract(`${result.stdout}\n${result.stderr}`);
}

/** Pull the first version-looking token out of arbitrary `--version` output. */
export function firstVersionLike(text: string): string | null {
  const match = text.match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.]+)?)\b/);
  return match?.[1] ?? null;
}

export interface BuildItemInput {
  provider: ProviderId;
  environment?: string | null;
  id: string;
  name?: string;
  current: string;
  available: string;
  source?: string | null;
  pinned?: boolean;
  /** Where the package lives on disk, when the adapter can say. */
  location?: string | null;
}

/**
 * Turn a parsed row into an `UpdateItem`, or null when it should not be offered.
 *
 * Three rejections happen here, in one place, so no adapter can forget one:
 *  - an id that would be unsafe to hand back to a CLI,
 *  - a row whose "available" version is not actually newer than what is installed,
 *  - a row with no usable version on either side.
 */
export function buildItem(input: BuildItemInput): UpdateItem | null {
  const id = input.id.trim();
  if (!isSafePackageId(id)) return null;

  const current = input.current.trim();
  const available = input.available.trim();
  if (available.length === 0) return null;

  const uncertain = current.length === 0 || /^unknown$/i.test(current) || current.startsWith('<');
  if (!uncertain && !isRealUpgrade(current, available)) return null;

  const environment = input.environment ?? null;

  return {
    key: `${input.provider}:${environment ?? '-'}:${id}`,
    provider: input.provider,
    environment,
    id,
    name: (input.name ?? id).trim() || id,
    currentVersion: current.length > 0 ? current : 'Unknown',
    availableVersion: available,
    source: input.source?.trim() || null,
    pinned: input.pinned ?? false,
    uncertain,
    local: hasLocalVersion(current) && !hasLocalVersion(available),
    location: input.location?.trim() || null,
  };
}

/**
 * Does this version string carry a PEP 440 local version identifier?
 *
 * `2.0.1+cu118` does; `2.13.0` does not. Only meaningful when the INSTALLED version has one and the
 * available version does not, that is exactly the case where upgrading swaps build flavour.
 */
export function hasLocalVersion(version: string): boolean {
  return /^[^+\s]+\+[0-9A-Za-z.]+$/.test(version.trim());
}

/** Resolve a command, returning null when it is not installed. */
export async function locate(command: string): Promise<string | null> {
  return resolveBinary(command);
}

/**
 * Decide whether a scan command failed, given that "found outdated packages" is a non-zero exit for
 * several managers (`npm outdated` and `pnpm outdated` both exit 1 when they find something).
 *
 * A run counts as failed only when it produced no rows AND signalled trouble.
 */
export function scanFailed(result: CommandResult, itemCount: number): string | null {
  if (result.cancelled) return null;
  if (itemCount > 0) return null;
  if (result.timedOut) return 'The command timed out.';
  if (result.spawnFailed) return result.stderr.trim() || 'The command could not be started.';
  if (result.code === 0 || result.code === null) return null;

  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 3).join(' ');
  return detail.length > 0 ? detail : `Exited with code ${result.code}.`;
}
