/**
 * mac-run.test.ts: App Store and macOS updates, admin prompts, and running them on a Mac.
 */

import { constants as FS, accessSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../src/main/exec.js';
import type { ProviderId } from '../src/shared/types.js';
import { assertSafeArg } from '../src/main/exec.js';
import { parseMasOutdated } from '../src/main/providers/mas.js';
import { parseSoftwareUpdateList, sudoDeclined, sudoPrompt } from '../src/main/providers/softwareupdate.js';
import { buildItem } from '../src/main/providers/util.js';
import { runningAppsAmong } from '../src/main/platform/mac-apps.js';
import { __test as sessionTest, appBundlesIn, orderForRun } from '../src/main/session.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const result = (patch: Partial<CommandResult>): CommandResult => ({
  code: 1,
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

describe('parseMasOutdated', () => {
  it('reads id, name and both versions from real output', () => {
    expect(parseMasOutdated(readFixture('mas-outdated.txt'))).toEqual([
      { id: '302584613', name: 'Kindle', installed: '7.64', available: '7.69' },
      { id: '1295203466', name: 'Windows App', installed: '11.3.8', available: '11.4.4' },
    ]);
  });

  it('reads nothing from empty output', () => {
    expect(parseMasOutdated('')).toEqual([]);
  });
});

describe('parseSoftwareUpdateList', () => {
  it('reads labels, titles, versions and the restart flag', () => {
    expect(parseSoftwareUpdateList(readFixture('softwareupdate-list.txt'))).toEqual([
      { label: 'Safari27.0TahoeAuto-27.0', title: 'Safari', version: '27.0', restart: false },
      { label: 'macOS Tahoe 26.7.1-25G241', title: 'macOS Tahoe 26.7.1', version: '26.7.1', restart: true },
      { label: 'macOS 27.0.1-26A434', title: 'macOS 27.0.1', version: '27.0.1', restart: true },
    ]);
  });

  it('reads nothing when there is no new software', () => {
    expect(parseSoftwareUpdateList(readFixture('softwareupdate-none.txt'))).toEqual([]);
  });
});

describe('macOS update items', () => {
  it('keeps a label with spaces as the id, because softwareupdate needs it verbatim', () => {
    const item = buildItem({ provider: 'softwareupdate', id: 'macOS Tahoe 26.7.1-25G241', current: '', available: '26.7.1', allowSpaces: true });
    expect(item?.id).toBe('macOS Tahoe 26.7.1-25G241');
  });

  it('still refuses spaces in ids from every other manager', () => {
    expect(buildItem({ provider: 'brew', id: 'evil name', current: '1.0', available: '1.1' })).toBeNull();
  });

  it('builds a password prompt the argument filter accepts, whatever the update is called', () => {
    const prompt = sudoPrompt('Command Line Tools (macOS 27), 100% "safe"');
    expect(prompt).toBe('Enter your administrator password to install Command Line Tools macOS 27 100 safe.');
    expect(() => assertSafeArg(prompt, 'darwin')).not.toThrow();
  });
});

describe('argument safety by platform', () => {
  it('allows a plain space on macOS, where there is no shell to split it', () => {
    expect(() => assertSafeArg('macOS Tahoe 26.7.1-25G241', 'darwin')).not.toThrow();
  });

  it('still refuses a space on Windows', () => {
    expect(() => assertSafeArg('macOS Tahoe 26.7.1-25G241', 'win32')).toThrow();
  });

  it.each(['a & b', 'a;b', 'a|b', "a'b", 'a"b', 'a\nb', 'a\tb', 'a%b', 'a,b', ''])(
    'still refuses %j on macOS',
    (arg) => {
      expect(() => assertSafeArg(arg, 'darwin')).toThrow();
    },
  );
});

describe('admin prompts', () => {
  it('recognises a declined password dialog', () => {
    expect(sudoDeclined('sudo: no password was provided\nsudo: a password is required\n')).toBe(true);
    expect(sudoDeclined('Installing macOS 27.0.1\n')).toBe(false);
  });

  it('says plainly when the password was not entered', () => {
    const v = sessionTest.classify('softwareupdate', result({ stderr: 'sudo: no password was provided\n' }));
    expect(v.status).toBe('failed');
    expect(v.detail).toMatch(/^Administrator password was not entered/);
  });

  it('tells the user to sign in when the App Store refuses', () => {
    const v = sessionTest.classify('mas', result({ stderr: 'Error: Not signed in to the App Store\n' }));
    expect(v.detail).toMatch(/^Sign in to the App Store and try again/);
  });
});

describe('orderForRun', () => {
  it('runs macOS updates last and keeps everything else in table order', () => {
    const items: Array<{ provider: ProviderId; key: string }> = [
      { provider: 'softwareupdate', key: 'a' },
      { provider: 'brew', key: 'b' },
      { provider: 'mas', key: 'c' },
      { provider: 'softwareupdate', key: 'd' },
      { provider: 'npm', key: 'e' },
    ];
    expect(orderForRun(items).map((i) => i.key)).toEqual(['b', 'c', 'e', 'a', 'd']);
  });
});

describe('appBundlesIn', () => {
  it('lists the app bundles a run will replace, from cask and App Store rows only', () => {
    const items = [
      { provider: 'brew-cask', location: '/Applications/OrbStack.app' },
      { provider: 'mas', location: '/Applications/Kindle.app' },
      { provider: 'brew', location: '/opt/homebrew/Cellar/node/26.12.1' },
      { provider: 'brew-cask', location: null },
    ];
    expect(appBundlesIn(items as never)).toEqual(['/Applications/OrbStack.app', '/Applications/Kindle.app']);
  });
});

describe('runningAppsAmong', () => {
  it('names the selected apps whose executable is running', () => {
    const ps = [
      '/sbin/launchd',
      '/Applications/OrbStack.app/Contents/MacOS/OrbStack',
      '/Applications/Pika.app/Contents/MacOS/Pika',
      '/Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper',
    ].join('\n');
    expect(runningAppsAmong(['/Applications/OrbStack.app', '/Applications/Rectangle.app', '/Applications/Pika.app'], ps)).toEqual([
      'OrbStack',
      'Pika',
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('askpass helper', () => {
  const askpass = join(import.meta.dirname, '..', 'resources', 'mac', 'askpass');

  it('ships as an executable file', () => {
    expect(() => accessSync(askpass, FS.X_OK)).not.toThrow();
  });

  it('interpolates nothing but its first argument', () => {
    const vars = readFileSync(askpass, 'utf8').match(/\$[{A-Za-z0-9@*#?]+/g) ?? [];
    expect(new Set(vars)).toEqual(new Set(['$1']));
  });
});

import { masUpgradeCommand } from '../src/main/providers/mas.js';

describe('masUpgradeCommand', () => {
  it('runs mas 7 and later through sudo -A, which it needs to update apps', () => {
    expect(masUpgradeCommand('7.0.0', '/opt/homebrew/bin/mas', '302584613', 'Kindle')).toEqual({
      file: '/usr/bin/sudo',
      args: ['-A', '-p', 'Enter your administrator password to install Kindle.', '/opt/homebrew/bin/mas', 'upgrade', '302584613'],
      elevated: true,
    });
  });

  it('runs older mas directly, as it never needed root', () => {
    expect(masUpgradeCommand('6.0.1', '/opt/homebrew/bin/mas', '302584613', 'Kindle')).toEqual({
      file: '/opt/homebrew/bin/mas',
      args: ['upgrade', '302584613'],
      elevated: false,
    });
  });
});
