/**
 * mac-env.ts: the environment a Terminal window would have, for an app launched from Finder or the Dock.
 *
 * GUI apps on macOS inherit launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has no
 * `/opt/homebrew/bin`, so brew, npm, uv and cargo would all read as "not installed". The fix is to ask
 * the user's login shell once, at startup, what its environment is.
 *
 * This is the one shell the app starts. Its arguments are fixed (`-il`), the command it runs is a fixed
 * string sent on stdin (the argument filter rightly refuses the space in `env -0`), and the output is
 * parsed as data, never evaluated. If anything goes wrong the caller falls back to `fallbackEnv`.
 */

import type { CommandResult } from '../exec.js';

/** Variables package managers read; nothing else from the shell is adopted. */
const KEEP = /^(PATH|HOMEBREW_[A-Z_]+|CARGO_HOME|RUSTUP_HOME|UV_[A-Z_]+|PNPM_HOME)$/;

export const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/** Parse `env -0` output. Text before the first entry (a shell banner) is ignored. */
export function parseNulEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = text.split('\0');
  for (let i = 0; i < entries.length; i++) {
    let entry = entries[i]!;
    // The first entry may carry a banner the rc files printed; the real entry starts after it.
    if (i === 0) entry = entry.slice(entry.lastIndexOf('\n') + 1);
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export function pickEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (KEEP.test(key)) out[key] = value;
  return out;
}

/** Where managers live on a typical Mac, ahead of the PATH the app was launched with. */
export function fallbackEnv(home: string, current: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const preferred = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    `${home}/.cargo/bin`,
    `${home}/.local/bin`,
  ];
  const existing = (current.PATH ?? '').split(':').filter(Boolean);
  const merged = [...preferred, ...existing.filter((dir) => !preferred.includes(dir))];
  return { PATH: merged.join(':') };
}

export type ShellRunner = (options: {
  file: string;
  args: string[];
  timeoutMs: number;
  input: string;
  settleWhen?: (stdout: string) => boolean;
}) => Promise<CommandResult>;

/**
 * Markers around the environment block. Anything an rc file prints lands outside them, banner or not,
 * and seeing the end marker means the answer is complete even while a backgrounded rc job keeps the
 * pipe open.
 */
const BEGIN = '__FATE_ENV_BEGIN__';
const END = '__FATE_ENV_END__';
const COMMAND = `/usr/bin/printf '\\n${BEGIN}\\0'; /usr/bin/env -0; /usr/bin/printf '${END}\\0'\nexit\n`;

/** The `env -0` block between the markers, or null when the end marker never arrived. */
export function betweenMarkers(stdout: string): string | null {
  const start = stdout.indexOf(`${BEGIN}\0`);
  const end = stdout.indexOf(END, start);
  if (start === -1 || end === -1) return null;
  return stdout.slice(start + BEGIN.length + 1, end);
}

/** Ask the login shell for its environment; null when it fails, times out or reports no PATH. */
export async function readLoginShellEnv(shell: string, run: ShellRunner): Promise<NodeJS.ProcessEnv | null> {
  const result = await run({
    file: shell,
    args: ['-il'],
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    input: COMMAND,
    settleWhen: (stdout) => stdout.includes(END),
  });
  const block = betweenMarkers(result.stdout);
  if (block === null) return null;
  const env = pickEnv(parseNulEnv(block));
  return env.PATH ? env : null;
}
