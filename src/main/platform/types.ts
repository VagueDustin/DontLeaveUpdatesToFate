/**
 * platform/types.ts: the jobs that differ between Windows and macOS.
 *
 * Everything else in the main process is shared. Callers import `platform` from `./index.js` and never
 * test `process.platform` themselves, so each OS difference lives in exactly one place.
 */

import type { HandoverResult } from '../handover.js';
import type { ShortcutCensus } from '../shortcuts.js';
import type { BrokenShortcut } from '../../shared/types.js';

export type PlatformId = 'windows' | 'mac';

/**
 * How this OS gets administrator rights.
 *
 * Windows restarts the whole app elevated through UAC. macOS never restarts: the few commands that need
 * root run through `sudo -A`, and the askpass helper shows the native password dialog per command.
 */
export type ElevationModel =
  | {
      kind: 'relaunch';
      isElevated(): Promise<boolean>;
      relaunch(target: string, workDir: string): HandoverResult;
    }
  | {
      kind: 'askpass';
      /** Absolute path of the bundled askpass helper, for `SUDO_ASKPASS`. */
      askpassPath(): string;
      /** Count of password prompts this session, for the log header. */
      stats(): { shown: number; declined: number };
      recordPrompt(declined: boolean): void;
    };

/** On macOS `lnk` holds the .app path and `target` its executable; the shape is shared with Windows. */
export type AppCensus = ShortcutCensus;

export interface PlatformServices {
  readonly id: PlatformId;
  /** Show a file or folder in Explorer or Finder. False when neither it nor its parent exists. */
  revealInFileManager(path: string): Promise<boolean>;
  readonly elevation: ElevationModel;
  takeAppCensus(timeoutMs?: number): Promise<AppCensus>;
  diffBrokenApps(before: AppCensus, after: AppCensus): BrokenShortcut[];
  /** The login shell's environment (macOS); null when unavailable or not applicable. */
  loginShellEnv(): Promise<NodeJS.ProcessEnv | null>;
  /** One line for the log header, e.g. "macOS 27.0.1 (26A434)". */
  osDescription(): Promise<string>;
}
