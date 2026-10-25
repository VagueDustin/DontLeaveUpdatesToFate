/**
 * mac-env.test.ts: picking up the login shell's environment when the app is launched from Finder.
 */

import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../src/main/exec.js';
import { fallbackEnv, parseNulEnv, pickEnv, readLoginShellEnv } from '../src/main/platform/mac-env.js';

const result = (patch: Partial<CommandResult>): CommandResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  lines: [],
  timedOut: false,
  cancelled: false,
  spawnFailed: false,
  durationMs: 1,
  display: '',
  ...patch,
});

describe('parseNulEnv', () => {
  it('parses NUL-separated env output and ignores a banner before it', () => {
    const out = 'Welcome to zsh!\nPATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/dev\0CARGO_HOME=/Users/dev/.cargo\0';
    const env = parseNulEnv(out);
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(env.CARGO_HOME).toBe('/Users/dev/.cargo');
  });

  it('keeps values that contain = and newlines', () => {
    const env = parseNulEnv('A=x=y\0B=line1\nline2\0');
    expect(env.A).toBe('x=y');
    expect(env.B).toBe('line1\nline2');
  });
});

describe('pickEnv', () => {
  it('keeps only the variables managers need', () => {
    const picked = pickEnv({
      PATH: 'a',
      SECRET_TOKEN: 'x',
      HOMEBREW_PREFIX: '/opt/homebrew',
      UV_CACHE_DIR: 'c',
      PNPM_HOME: 'p',
      RUSTUP_HOME: 'r',
    });
    expect(Object.keys(picked).sort()).toEqual(['HOMEBREW_PREFIX', 'PATH', 'PNPM_HOME', 'RUSTUP_HOME', 'UV_CACHE_DIR']);
  });
});

describe('fallbackEnv', () => {
  it('puts Homebrew and user bins before the system path', () => {
    expect(fallbackEnv('/Users/dev', { PATH: '/usr/bin:/bin' }).PATH).toBe(
      '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/dev/.cargo/bin:/Users/dev/.local/bin:/usr/bin:/bin',
    );
  });

  it('does not repeat a directory the current PATH already has', () => {
    expect(fallbackEnv('/Users/dev', { PATH: '/opt/homebrew/bin:/usr/bin' }).PATH).toBe(
      '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/dev/.cargo/bin:/Users/dev/.local/bin:/usr/bin',
    );
  });
});

describe('readLoginShellEnv', () => {
  it('asks the login shell with fixed arguments, the command on stdin, and a 3 second budget', async () => {
    let seen: { file: string; args: string[]; timeoutMs: number; input: string } | null = null;
    const env = await readLoginShellEnv('/bin/zsh', async (o) => {
      seen = o;
      return result({ stdout: 'PATH=/opt/homebrew/bin:/usr/bin\0' });
    });
    expect(seen).toEqual({ file: '/bin/zsh', args: ['-il'], timeoutMs: 3_000, input: '/usr/bin/env -0\nexit\n' });
    expect(env?.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('returns null when the shell times out', async () => {
    expect(await readLoginShellEnv('/bin/zsh', async () => result({ code: null, timedOut: true }))).toBeNull();
  });

  it('returns null when the output has no PATH', async () => {
    expect(await readLoginShellEnv('/bin/zsh', async () => result({ stdout: 'garbage' }))).toBeNull();
  });
});
