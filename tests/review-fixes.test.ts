/**
 * review-fixes.test.ts: regressions found by the final review of the macOS port.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runCommand } from '../src/main/exec.js';
import { readLoginShellEnv } from '../src/main/platform/mac-env.js';
import { skipAppleStub } from '../src/main/providers/pip.js';
import { isMajorUpgrade } from '../src/main/providers/softwareupdate.js';

const posix = process.platform !== 'win32';

async function script(body: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dlutf-review-'));
  const path = join(dir, 'fake-shell');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { path, dir };
}

describe.skipIf(!posix)('login shell lookup does not wait on background jobs', () => {
  it('accepts the environment as soon as it is printed, even if an rc job keeps the pipe open', async () => {
    // An rc file that backgrounds a job holding stdout, then a shell that runs what arrives on stdin.
    const { path, dir } = await script('(sleep 20) &\nexec /bin/sh');
    const started = Date.now();
    const env = await readLoginShellEnv(path, runCommand);
    expect(env?.PATH).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2_000);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);

  it('ignores a banner printed without a trailing newline', async () => {
    const { path, dir } = await script("printf 'Welcome!'\nexec /bin/sh");
    const env = await readLoginShellEnv(path, runCommand);
    expect(env?.PATH).toBe(process.env.PATH);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);
});

describe.skipIf(!posix)('a run that outlives its own group still finishes', () => {
  it('settles shortly after the command exits when cancelled, even if a detached grandchild holds stdout', async () => {
    // perl's setsid() leaves the group, so the group kill cannot reach it; it keeps stdout open.
    const { path, dir } = await script("perl -e 'use POSIX; POSIX::setsid(); sleep 20' &\necho started\nsleep 30");
    const controller = new AbortController();
    const run = runCommand({
      file: path,
      args: [],
      timeoutMs: 20_000,
      signal: controller.signal,
      onLine: (line) => {
        if (line === 'started') setTimeout(() => controller.abort(), 200);
      },
    });
    const started = Date.now();
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(dir, { recursive: true, force: true });
  }, 15_000);
});

describe('Apple’s python3 stub', () => {
  it('is skipped when the developer tools are not installed, so probing never pops Apple’s install dialog', () => {
    expect(skipAppleStub('/usr/bin/python3', false)).toBe(true);
    expect(skipAppleStub('/usr/bin/python3', true)).toBe(false);
    expect(skipAppleStub('/opt/homebrew/bin/python3.13', false)).toBe(false);
  });
});

describe('major macOS upgrades', () => {
  it('are recognised against the running major version', () => {
    expect(isMajorUpgrade('27.0.1', '26.7.0')).toBe(true);
    expect(isMajorUpgrade('26.7.1', '26.7.0')).toBe(false);
    expect(isMajorUpgrade('27.0', '27.0.1')).toBe(false);
    expect(isMajorUpgrade('', '26.7.0')).toBe(false);
  });
});
