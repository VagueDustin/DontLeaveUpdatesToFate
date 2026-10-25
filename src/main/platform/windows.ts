/**
 * platform/windows.ts: the Windows implementation, which is the code that shipped before macOS support,
 * moved behind the platform interface without changing its behaviour.
 */

import { release } from 'node:os';

import { isElevated, relaunchElevated } from '../elevation.js';
import { diffBrokenShortcuts, takeShortcutCensus } from '../shortcuts.js';
import { revealWithShell } from './reveal.js';
import type { PlatformServices } from './types.js';

export const windowsPlatform: PlatformServices = {
  id: 'windows',
  revealInFileManager: revealWithShell,
  elevation: {
    kind: 'relaunch',
    isElevated,
    relaunch: (target, workDir) => relaunchElevated(target, workDir),
  },
  takeAppCensus: (timeoutMs) => takeShortcutCensus(timeoutMs),
  diffBrokenApps: diffBrokenShortcuts,
  loginShellEnv: async () => null,
  osDescription: async () => `${process.platform} ${release()}`,
};
