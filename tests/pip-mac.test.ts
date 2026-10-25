/**
 * pip-mac.test.ts: finding Pythons on a Mac, leaving managed ones alone, and Mac paths in the table.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { macEnvironmentLabel, managedBy, macInterpreterCandidates } from '../src/main/providers/pip.js';
import { compactPath } from '../src/shared/format.js';

async function exe(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
}

describe.skipIf(process.platform === 'win32')('macInterpreterCandidates', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dlutf-py-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds Pythons on PATH, in Homebrew and in uv, once each', async () => {
    const bin = join(root, 'bin');
    await exe(join(bin, 'python3.12'));
    await symlink(join(bin, 'python3.12'), join(bin, 'python3'));
    const brew = join(root, 'homebrew');
    await exe(join(brew, 'opt', 'python@3.13', 'bin', 'python3.13'));
    const uv = join(root, 'uv');
    await exe(join(uv, 'cpython-3.12-macos-aarch64-none', 'bin', 'python3.12'));

    const found = await macInterpreterCandidates([bin], brew, uv);
    expect(found.map((c) => c.path).sort()).toEqual(
      [
        join(bin, 'python3.12'),
        join(brew, 'opt', 'python@3.13', 'bin', 'python3.13'),
        join(uv, 'cpython-3.12-macos-aarch64-none', 'bin', 'python3.12'),
      ].sort(),
    );
    expect(new Set(found.map((c) => c.tag)).size).toBe(found.length);
  });
});

describe('managedBy', () => {
  const brew = '/opt/homebrew';
  const uv = '/Users/dev/.local/share/uv/python';

  it('names Homebrew for a marked Homebrew Python', () => {
    expect(managedBy('/opt/homebrew/opt/python@3.13/bin/python3.13', true, brew, uv)).toBe('Managed by Homebrew');
  });

  it('names uv for a marked uv Python', () => {
    expect(managedBy(`${uv}/cpython-3.12-macos-aarch64-none/bin/python3.12`, true, brew, uv)).toBe('Managed by uv');
  });

  it('treats Apple’s own Python as managed by the system, marker or not', () => {
    expect(managedBy('/usr/bin/python3', false, brew, uv)).toBe('Managed by the system');
  });

  it('leaves an unmarked Python of your own alone', () => {
    expect(managedBy('/Users/dev/.pyenv/versions/3.11.9/bin/python3.11', false, brew, uv)).toBeNull();
  });
});

describe('compactPath on POSIX paths', () => {
  it('shortens with forward slashes', () => {
    expect(compactPath('/opt/homebrew/lib/node_modules/npm', 20)).toBe('…/node_modules/npm');
  });

  it('keeps a short path whole, with its leading slash', () => {
    expect(compactPath('/Applications/Pika.app', 40)).toBe('/Applications/Pika.app');
  });

  it('still uses backslashes for Windows paths', () => {
    expect(compactPath('C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\npm', 24)).toBe('…\\node_modules\\npm');
  });
});

describe('macEnvironmentLabel', () => {
  it('says where each Python came from', () => {
    expect(macEnvironmentLabel({ tag: 'uv-3.12', path: '/x' })).toBe('Python 3.12 · uv');
    expect(macEnvironmentLabel({ tag: 'brew-3.13-2', path: '/x' })).toBe('Python 3.13 · Homebrew');
    expect(macEnvironmentLabel({ tag: '3.9', path: '/usr/bin/python3' })).toBe('Python 3.9 · system');
    expect(macEnvironmentLabel({ tag: '3.11', path: '/Users/dev/.pyenv/shims/python3.11' })).toBe('Python 3.11 · user');
  });
});

describe.skipIf(process.platform === 'win32')('Rust homes on a Mac', () => {
  it('default to ~/.rustup and ~/.cargo', async () => {
    const { cargoHome, rustupHome } = await import('../src/main/providers/rust.js');
    const saved = { HOME: process.env.HOME, RUSTUP_HOME: process.env.RUSTUP_HOME, CARGO_HOME: process.env.CARGO_HOME };
    process.env.HOME = '/Users/dev';
    delete process.env.RUSTUP_HOME;
    delete process.env.CARGO_HOME;
    try {
      expect(rustupHome()).toBe('/Users/dev/.rustup');
      expect(cargoHome('/Users/dev/.cargo/bin/cargo')).toBe('/Users/dev/.cargo');
      expect(cargoHome(null)).toBe('/Users/dev/.cargo');
    } finally {
      Object.assign(process.env, saved);
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    }
  });
});
