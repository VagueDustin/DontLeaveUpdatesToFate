/**
 * platform/mac.ts: the macOS implementation.
 */

import { join } from 'node:path';
import { app } from 'electron';

import { runCommand } from '../exec.js';
import { diffBrokenShortcuts } from '../shortcuts.js';
import { revealWithShell } from './reveal.js';
import type { PlatformServices } from './types.js';

/** `sw_vers` prints `ProductVersion:\t27.0.1` and `BuildVersion:\t26A434`; one header line from both. */
export function parseSwVers(text: string): string {
  const field = (name: string): string | null =>
    new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(text)?.[1] ?? null;
  const version = field('ProductVersion');
  const build = field('BuildVersion');
  if (!version) return 'macOS';
  return build ? `macOS ${version} (${build})` : `macOS ${version}`;
}

/** The askpass helper ships in the app's resources; in development it is read from the repo. */
function resourcesDir(): string {
  return app?.isPackaged ? process.resourcesPath : join(app?.getAppPath?.() ?? process.cwd(), 'resources');
}

const prompts = { shown: 0, declined: 0 };

export const macPlatform: PlatformServices = {
  id: 'mac',
  revealInFileManager: revealWithShell,
  elevation: {
    kind: 'askpass',
    askpassPath: () => join(resourcesDir(), 'mac', 'askpass'),
    stats: () => ({ ...prompts }),
    recordPrompt(declined) {
      prompts.shown += 1;
      if (declined) prompts.declined += 1;
    },
  },
  takeAppCensus: async () => new Map(),
  diffBrokenApps: diffBrokenShortcuts,
  loginShellEnv: async () => null,
  async osDescription() {
    const result = await runCommand({ file: '/usr/bin/sw_vers', args: [], timeoutMs: 5_000 });
    return parseSwVers(result.stdout);
  },
};
