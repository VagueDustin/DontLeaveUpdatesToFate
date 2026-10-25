/**
 * platform/mac.ts: the macOS implementation.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

import { runCommand } from '../exec.js';
import { takeAppCensusIn } from './mac-apps.js';
import { readLoginShellEnv } from './mac-env.js';
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
/** A file shipped in the app's `mac` resources folder (askpass, swap-app.sh). */
export function macResource(name: string): string {
  return join(resourcesDir(), 'mac', name);
}

function resourcesDir(): string {
  return app?.isPackaged ? process.resourcesPath : join(app?.getAppPath?.() ?? process.cwd(), 'resources');
}

const prompts = { shown: 0, declined: 0 };

export const macPlatform: PlatformServices = {
  id: 'mac',
  revealInFileManager: revealWithShell,
  elevation: {
    kind: 'askpass',
    askpassPath: () => macResource('askpass'),
    stats: () => ({ ...prompts }),
    recordPrompt(declined) {
      prompts.shown += 1;
      if (declined) prompts.declined += 1;
    },
  },
  takeAppCensus: () => takeAppCensusIn(['/Applications', join(homedir(), 'Applications')]),
  diffBrokenApps: diffBrokenShortcuts,
  loginShellEnv: () => readLoginShellEnv(process.env.SHELL || '/bin/zsh', runCommand),
  async osDescription() {
    const result = await runCommand({ file: '/usr/bin/sw_vers', args: [], timeoutMs: 5_000 });
    return parseSwVers(result.stdout);
  },
};
