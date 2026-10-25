/**
 * exec-posix.test.ts: finding and stopping commands on macOS (and any POSIX system).
 *
 * Windows resolves a bare name by trying each PATHEXT extension; a Mac has no extensions, so a
 * resolver that only tries `.EXE`/`.CMD` finds nothing at all. Cancel has the matching problem:
 * `taskkill /T` does not exist, and signalling only the direct child leaves an installer's own
 * children running.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearResolveCache, resolveBinary, runCommand } from '../src/main/exec.js';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('resolveBinary on POSIX', () => {
  let dir: string;
  const savedPath = process.env.PATH;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dlutf-bin-'));
    process.env.PATH = dir;
    clearResolveCache();
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    clearResolveCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves an extensionless executable on PATH', async () => {
    await writeFile(join(dir, 'fakebrew'), '#!/bin/sh\necho ok\n');
    await chmod(join(dir, 'fakebrew'), 0o755);
    expect(await resolveBinary('fakebrew')).toBe(join(dir, 'fakebrew'));
  });

  it('ignores a non-executable file of the same name', async () => {
    await writeFile(join(dir, 'fakebrew'), 'not a program\n');
    await chmod(join(dir, 'fakebrew'), 0o644);
    expect(await resolveBinary('fakebrew')).toBeNull();
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!posix)('cancel on POSIX', () => {
  it('kills the whole process group, not just the direct child', async () => {
    const controller = new AbortController();
    let grandchild = 0;

    // A script used only by this test: it starts a background sleep (the grandchild), prints its pid,
    // then waits on it, which is the shape of an installer that spawns its own helper. It lives in a
    // file because the argument deny-list rightly refuses `&` and `;` on a command line.
    const dir = await mkdtemp(join(tmpdir(), 'dlutf-group-'));
    const script = join(dir, 'spawner.sh');
    await writeFile(script, '#!/bin/sh\nsleep 30 &\necho $!\nwait\n');
    await chmod(script, 0o755);

    const run = runCommand({
      file: '/bin/sh',
      args: [script],
      timeoutMs: 20_000,
      signal: controller.signal,
      onLine: (line) => {
        if (!grandchild && /^\d+$/.test(line.trim())) {
          grandchild = Number(line.trim());
          controller.abort();
        }
      },
    });

    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(grandchild).toBeGreaterThan(0);

    const deadline = Date.now() + 4_000;
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(grandchild)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);
});
