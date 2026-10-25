/**
 * mac-apps.test.ts: the macOS "did this update leave an app unable to launch?" census.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { censusWords, takeAppCensusIn } from '../src/main/platform/mac-apps.js';
import { diffBrokenShortcuts } from '../src/main/shortcuts.js';

const xmlPlist = (exe: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n` +
  `<key>CFBundleName</key><string>Thing</string>\n` +
  `<key>CFBundleExecutable</key>\n\t<string>${exe}</string>\n</dict></plist>\n`;

async function bundle(root: string, name: string, exe: string, opts: { plist?: string; mode?: number; skipExe?: boolean } = {}) {
  const app = join(root, `${name}.app`);
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), opts.plist ?? xmlPlist(exe));
  if (!opts.skipExe) {
    await writeFile(join(app, 'Contents', 'MacOS', exe), '#!/bin/sh\n');
    await chmod(join(app, 'Contents', 'MacOS', exe), opts.mode ?? 0o755);
  }
  return app;
}

describe.skipIf(process.platform === 'win32')('takeAppCensusIn', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dlutf-apps-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('marks a complete bundle ok', async () => {
    const app = await bundle(root, 'Pika', 'Pika');
    const census = await takeAppCensusIn([root]);
    expect(census.get(app)).toMatchObject({ name: 'Pika', ok: true, target: join(app, 'Contents', 'MacOS', 'Pika') });
  });

  it('marks a bundle whose executable vanished as broken', async () => {
    const app = await bundle(root, 'Pika', 'Pika', { skipExe: true });
    expect((await takeAppCensusIn([root])).get(app)?.ok).toBe(false);
  });

  it('marks a bundle whose executable lost its execute bit as broken', async () => {
    const app = await bundle(root, 'Pika', 'Pika', { mode: 0o644 });
    expect((await takeAppCensusIn([root])).get(app)?.ok).toBe(false);
  });

  it('accepts a binary plist when an executable it names is present', async () => {
    const binary = `bplist00Ñ\u0001\u0002_\u0010\u0012CFBundleExecutableUOrbStack\u0008`;
    const app = await bundle(root, 'OrbStack', 'OrbStack', { plist: binary });
    expect((await takeAppCensusIn([root])).get(app)?.ok).toBe(true);
  });

  it('reads an iPhone or iPad app wrapped for the Mac (WrappedBundle layout)', async () => {
    // /Applications/Audible.app/WrappedBundle -> Wrapper/Audible.app, executable at that bundle's root.
    const app = join(root, 'Audible.app');
    const inner = join(app, 'Wrapper', 'Audible.app');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'Info.plist'), xmlPlist('Audible'));
    await writeFile(join(inner, 'Audible'), '#!/bin/sh\n');
    await chmod(join(inner, 'Audible'), 0o755);
    await symlink('Wrapper/Audible.app', join(app, 'WrappedBundle'));

    expect((await takeAppCensusIn([root])).get(app)).toMatchObject({ ok: true, target: join(app, 'WrappedBundle', 'Audible') });

    await rm(join(inner, 'Audible'));
    expect((await takeAppCensusIn([root])).get(app)?.ok).toBe(false);
  });

  it('skips folders that do not exist', async () => {
    await expect(takeAppCensusIn([join(root, 'nope')])).resolves.toEqual(new Map());
  });

  it('diff reports apps that were ok before and broken after, and ignores new or removed apps', async () => {
    const pika = await bundle(root, 'Pika', 'Pika');
    const gone = await bundle(root, 'Gone', 'Gone');
    const before = await takeAppCensusIn([root]);

    await rm(join(pika, 'Contents', 'MacOS', 'Pika'));
    await rm(gone, { recursive: true });
    await bundle(root, 'New', 'New', { skipExe: true });
    const after = await takeAppCensusIn([root]);

    const broken = diffBrokenShortcuts(before, after);
    expect(broken.map((b) => b.name)).toEqual(['Pika']);
  });
});

describe('census wording', () => {
  it('talks about shortcuts on Windows and apps on a Mac', () => {
    expect(censusWords('windows').before).toBe('Recording shortcut targets before the run.');
    expect(censusWords('mac').before).toBe('Recording which apps can launch before the run.');
    expect(censusWords('mac').broken(2)).toBe('2 app(s) stopped launching during this run, an update moved or removed what they need.');
    expect(censusWords('windows').broken(2)).toBe('2 shortcut(s) stopped working during this run, an upgrade moved or removed its target.');
  });
});
