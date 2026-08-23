/**
 * parsers.test.ts — every parser, against output captured from a real Windows machine.
 *
 * The fixtures in `tests/fixtures/` are verbatim stdout from winget, choco, npm, pip, rustup and the
 * Python launcher on the build machine, with one substitution: the Windows account name in any path is
 * `dev`, because a public repository is no place for somebody's username and no parser here can tell
 * the difference. They exist because the failure mode for this app is a parser
 * that looks right and silently drops or mangles rows — which is invisible without a real sample.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cleanLine,
  collapseCarriageReturns,
  compareVersions,
  extractFirstJson,
  classifyStderr,
  isNoiseLine,
  isRealUpgrade,
  parseLooseJson,
  stripAnsi,
} from '../src/main/text.js';
import { displayWidth, parseTables, readHeader, sliceRow } from '../src/main/table.js';
import { parseWingetUpgrade } from '../src/main/providers/winget.js';
import { parseChocoOutdated } from '../src/main/providers/chocolatey.js';
import { buildItem, hasLocalVersion } from '../src/main/providers/util.js';
import { parseRustupCheck } from '../src/main/providers/rust.js';
import { parseLauncherList } from '../src/main/providers/pip.js';
import { __test as nodeTest } from '../src/main/providers/node.js';
import { assertSafeArg, displayCommand, isSafePackageId, sniffEncoding } from '../src/main/exec.js';
import { isSkipped, type SkipRule } from '../src/shared/types.js';
import { normaliseSettings } from '../src/main/settings.js';
import { diffBrokenShortcuts } from '../src/main/shortcuts.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureLines = (name: string): string[] =>
  fixture(name)
    .split('\n')
    .map((l) => cleanLine(l));

// ── text helpers ──────────────────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes colour codes but keeps the text', () => {
    expect(stripAnsi('\u001B[32mdone\u001B[0m')).toBe('done');
  });

  it('removes OSC title sequences', () => {
    expect(stripAnsi('\u001B]0;installing\u0007ready')).toBe('ready');
  });

  it('removes cursor movement used by progress bars', () => {
    expect(stripAnsi('\u001B[2K\u001B[1Ginstalling')).toBe('installing');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripAnsi('Git.Git  2.54.0  2.55.0.3  winget')).toBe('Git.Git  2.54.0  2.55.0.3  winget');
  });

  it('drops NUL and BEL leftovers', () => {
    expect(stripAnsi('a\u0000b\u0007c')).toBe('abc');
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps only the final frame of a progress rewrite', () => {
    expect(collapseCarriageReturns('  0%\r 50%\r100%')).toBe('100%');
  });

  it('is a no-op without a carriage return', () => {
    expect(collapseCarriageReturns('plain line')).toBe('plain line');
  });
});

describe('isNoiseLine', () => {
  it.each([
    '',
    '   ',
    '------------------------',
    '████████▒▒▒▒',
    '  45%',
    '  12.4 MB / 58.1 MB',
    'This is try 1/3. Retrying after 300 milliseconds.',
  ])('treats %j as noise', (line) => {
    expect(isNoiseLine(line)).toBe(true);
  });

  it.each([
    'chocolatey|2.7.2|2.7.3|false',
    'Git  Git.Git  2.54.0  2.55.0.3  winget',
    'Successfully installed pip-26.2',
  ])('keeps %j', (line) => {
    expect(isNoiseLine(line)).toBe(false);
  });
});

describe('extractFirstJson', () => {
  it('pulls an array out of output with trailing notices', () => {
    const raw = '[{"name":"pip"}]\n\n[notice] A new release of pip is available';
    expect(extractFirstJson(raw)).toBe('[{"name":"pip"}]');
  });

  it('ignores brackets inside strings', () => {
    expect(extractFirstJson('{"a":"]}"}')).toBe('{"a":"]}"}');
  });

  it('handles escaped quotes', () => {
    expect(extractFirstJson('{"a":"say \\"hi\\""}')).toBe('{"a":"say \\"hi\\""}');
  });

  it('returns null when there is no JSON', () => {
    expect(extractFirstJson('no json here')).toBeNull();
  });

  it('returns null on an unterminated value rather than throwing', () => {
    expect(extractFirstJson('[{"a":1}')).toBeNull();
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.2.3', '1.2.4', -1],
    ['1.2.4', '1.2.3', 1],
    ['1.2.3', '1.2.3', 0],
    ['1.2', '1.2.1', -1],
    ['1.2.0', '1.2', 0],
    ['7.1.2.2400', '7.1.2.2500', -1],
    ['9.9.1', '9.9.2', -1],
    ['150.0.7871.187', '151.0.7922.72', -1],
    // Numeric runs must compare numerically, not lexically: 10 > 9.
    ['1.9.0', '1.10.0', -1],
    ['2.7.2', '2.7.3', -1],
  ])('compares %s to %s', (a, b, expected) => {
    const result = compareVersions(a, b);
    expect(result === null ? null : Math.sign(result)).toBe(expected);
  });

  it('handles the yt-dlp style build strings winget reports', () => {
    const cmp = compareVersions('N-124279-g0f6ba39122-20260430', 'N-125365-g9a01c1cb6a-20260630');
    expect(cmp).not.toBeNull();
    expect(Math.sign(cmp!)).toBe(-1);
  });

  it('returns null when a side is not a version', () => {
    expect(compareVersions('Unknown', '1.1')).toBeNull();
    expect(compareVersions('', '1.1')).toBeNull();
  });

  it('ignores a leading comparison operator', () => {
    expect(compareVersions('< 172.1.0.13247', '172.1.0.13247')).toBe(0);
  });
});

describe('isRealUpgrade', () => {
  it('accepts a genuine bump', () => {
    expect(isRealUpgrade('1.0.0', '1.0.1')).toBe(true);
  });

  it('rejects an equal or older "available" version', () => {
    expect(isRealUpgrade('1.0.1', '1.0.1')).toBe(false);
    expect(isRealUpgrade('2.0.0', '1.0.1')).toBe(false);
  });

  it('trusts the manager when the versions are not comparable', () => {
    expect(isRealUpgrade('Unknown', '1.1')).toBe(true);
  });
});

// ── fixed-width table parsing ─────────────────────────────────────────────────────────────────

describe('displayWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(displayWidth('Git.Git')).toBe(7);
  });

  it('counts CJK as two cells each', () => {
    expect(displayWidth('日本語')).toBe(6);
  });

  it('ignores combining marks', () => {
    expect(displayWidth('e\u0301')).toBe(1);
  });
});

describe('readHeader + sliceRow', () => {
  const header =
    'Name                 Id              Version   Available   Source';

  it('finds each column start', () => {
    const schema = readHeader(header, ['Name', 'Id', 'Version', 'Available', 'Source'])!;
    expect(schema.columns.map((c) => c.label)).toEqual([
      'Name',
      'Id',
      'Version',
      'Available',
      'Source',
    ]);
    expect(schema.columns[0]!.start).toBe(0);
  });

  it('keeps a value that legitimately contains a space', () => {
    const schema = readHeader(header, ['Name', 'Id', 'Version', 'Available', 'Source'])!;
    const row =
      'Ubisoft Connect      Ubisoft.Connect < 172.1.0 172.1.0.132 winget';
    const cells = sliceRow(row, schema);
    expect(cells[0]).toBe('Ubisoft Connect');
    expect(cells[1]).toBe('Ubisoft.Connect');
  });

  it('returns null when a label is absent', () => {
    expect(readHeader('Name  Id', ['Name', 'Id', 'Version'])).toBeNull();
  });

  it('matches labels left to right so a substring cannot bind early', () => {
    const scoop = 'Name   Installed Version   Latest Version   Info';
    const schema = readHeader(scoop, ['Name', 'Installed Version', 'Latest Version'])!;
    expect(schema.columns[1]!.start).toBe(scoop.indexOf('Installed Version'));
    expect(schema.columns[2]!.start).toBe(scoop.indexOf('Latest Version'));
  });
});

describe('parseTables', () => {
  it('reads more than one table when each has its own header', () => {
    const lines = [
      'Name    Id      Version  Available  Source',
      '-----   ----    -------  ---------  ------',
      'A       a.a     1.0      1.1        winget',
      '',
      'The following packages have an upgrade available',
      'Name    Id      Version  Available  Source',
      '-----   ----    -------  ---------  ------',
      'B       b.b     2.0      2.1        winget',
    ];
    const tables = parseTables(lines, {
      labels: ['Name', 'Id', 'Version', 'Available', 'Source'],
    });
    expect(tables).toHaveLength(2);
    expect(tables[0]!.rows[0]![1]).toBe('a.a');
    expect(tables[1]!.rows[0]![1]).toBe('b.b');
  });
});

// ── winget, against real captured output ──────────────────────────────────────────────────────

describe('parseWingetUpgrade (real fixture)', () => {
  const items = parseWingetUpgrade(fixtureLines('winget-upgrade.txt'));

  it('finds exactly as many packages as winget itself reported', () => {
    // winget closes its output with "39 upgrades available." — asserting against that rather than a
    // number typed in by hand means this test still checks the right thing if the fixture is refreshed.
    const footer = fixtureLines('winget-upgrade.txt')
      .map((l) => /^(\d+)\s+upgrades?\s+available/i.exec(l.trim()))
      .find(Boolean);
    expect(footer).toBeTruthy();
    expect(items.length).toBe(Number(footer![1]));
  });

  it('never yields an id containing whitespace', () => {
    for (const item of items) expect(item.id).not.toMatch(/\s/);
  });

  it('yields only ids that are safe to hand back to a CLI', () => {
    for (const item of items) expect(isSafePackageId(item.id)).toBe(true);
  });

  it('reads a plain row correctly', () => {
    const git = items.find((i) => i.id === 'Git.Git');
    expect(git).toMatchObject({
      name: 'Git',
      currentVersion: '2.54.0',
      availableVersion: '2.55.0.3',
      source: 'winget',
    });
  });

  it('keeps a name that contains spaces and a version suffix', () => {
    const code = items.find((i) => i.id === 'Microsoft.VisualStudioCode');
    expect(code?.name).toBe('Microsoft Visual Studio Code (User)');
    expect(code?.currentVersion).toBe('1.122.0');
  });

  it('handles a version that fills its column with only one space after it', () => {
    const ffmpeg = items.find((i) => i.id === 'yt-dlp.FFmpeg');
    expect(ffmpeg?.currentVersion).toBe('N-124279-g0f6ba39122-20260430');
    expect(ffmpeg?.availableVersion).toBe('N-125365-g9a01c1cb6a-20260630');
  });

  it('flags a "< version" row as uncertain rather than dropping it', () => {
    const ubisoft = items.find((i) => i.id === 'Ubisoft.Connect');
    expect(ubisoft?.uncertain).toBe(true);
    expect(ubisoft?.availableVersion).toBe('172.1.0.13247');
  });

  it('flags an Unknown installed version as uncertain', () => {
    const openal = items.find((i) => i.id === 'CreativeTechnology.OpenAL');
    expect(openal?.uncertain).toBe(true);
    expect(openal?.currentVersion).toBe('Unknown');
  });

  it('reads a Microsoft Store row with its store id and source', () => {
    const store = items.find((i) => i.source === 'msstore');
    expect(store?.id).toBe('XP8K4RGX25G3GM');
    expect(store?.availableVersion).toBe('9.9.2');
  });

  it('gives every item a unique key', () => {
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it('never emits the count footer as a package', () => {
    expect(items.some((i) => /upgrades? available/i.test(i.name))).toBe(false);
  });
});

// ── chocolatey ────────────────────────────────────────────────────────────────────────────────

describe('parseChocoOutdated (real fixture)', () => {
  const items = parseChocoOutdated(fixtureLines('choco-outdated.txt'));

  it('reads all ten packages', () => {
    expect(items).toHaveLength(10);
  });

  it('ignores the self-update warning noise around the data', () => {
    expect(items.some((i) => /denied|try \d/i.test(i.name))).toBe(false);
  });

  it('reads a four-segment version', () => {
    const im = items.find((i) => i.id === 'imagemagick');
    expect(im).toMatchObject({ currentVersion: '7.1.2.2400', availableVersion: '7.1.2.2500' });
  });

  it('records the pinned flag', () => {
    for (const item of items) expect(item.pinned).toBe(false);
  });

  it('keeps a dotted package id intact', () => {
    expect(items.find((i) => i.id === 'imagemagick.app')).toBeDefined();
  });
});

// ── rustup ────────────────────────────────────────────────────────────────────────────────────

describe('parseRustupCheck (real fixture)', () => {
  const rows = parseRustupCheck(fixtureLines('rustup-check.txt'));

  it('reads only the toolchain that has an update', () => {
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'stable-x86_64-pc-windows-msvc',
      current: '1.95.0',
      available: '1.97.1',
    });
  });

  it('ignores the up-to-date line', () => {
    expect(rows.some((r) => r.id === 'rustup')).toBe(false);
  });

  it('reads rustup itself when it is the thing out of date', () => {
    const rows2 = parseRustupCheck(['rustup - update available: 1.28.0 -> 1.29.0']);
    expect(rows2[0]).toEqual({ id: 'rustup', current: '1.28.0', available: '1.29.0' });
  });
});

// ── pip ───────────────────────────────────────────────────────────────────────────────────────

describe('parseLauncherList (real fixture)', () => {
  const found = parseLauncherList(fixtureLines('py-list.txt'));

  it('finds all three interpreters', () => {
    expect(found).toHaveLength(3);
  });

  it('reads the tag and path, ignoring the default-marker asterisk', () => {
    expect(found[0]).toEqual({ tag: '3.14', path: 'C:\\Python314\\python.exe' });
  });

  it('keeps a path under the user profile', () => {
    expect(found[2]!.path).toBe(
      'C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
    );
  });
});

describe('pip outdated JSON (real fixture)', () => {
  it('parses despite the trailing upgrade notice', () => {
    const raw = `${fixture('pip-outdated.json')}\n\n[notice] A new release of pip is available: 26.1.1 -> 26.2`;
    const parsed = parseLooseJson<Array<{ name: string; latest_version: string }>>(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]).toMatchObject({ name: 'pip', latest_version: '26.2' });
  });
});

// ── npm ───────────────────────────────────────────────────────────────────────────────────────

describe('npm outdated (real fixture)', () => {
  const items = nodeTest.parseOutdated('npm', fixture('npm-outdated.json'));

  it('reads the one outdated global', () => {
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'npm',
      currentVersion: '11.17.0',
      availableVersion: '12.0.2',
      provider: 'npm',
    });
  });

  it('prefers latest over wanted', () => {
    const raw = '{"a":{"current":"1.0.0","wanted":"1.1.0","latest":"2.0.0"}}';
    expect(nodeTest.parseOutdated('npm', raw)[0]!.availableVersion).toBe('2.0.0');
  });

  it('takes the first entry when npm reports an array', () => {
    const raw = '{"a":[{"current":"1.0.0","latest":"2.0.0"}]}';
    expect(nodeTest.parseOutdated('npm', raw)).toHaveLength(1);
  });

  it('returns nothing for an empty report', () => {
    expect(nodeTest.parseOutdated('npm', '{}')).toEqual([]);
  });

  it('returns nothing rather than throwing on garbage', () => {
    expect(nodeTest.parseOutdated('npm', 'ENOENT: no such file')).toEqual([]);
  });

  it('drops an entry whose latest is not actually newer', () => {
    const raw = '{"a":{"current":"2.0.0","latest":"1.0.0"}}';
    expect(nodeTest.parseOutdated('npm', raw)).toEqual([]);
  });
});

// ── command-line safety ───────────────────────────────────────────────────────────────────────

describe('argument safety', () => {
  it.each([
    'a & calc',
    'a|b',
    'a>out.txt',
    'a"b',
    "a'b",
    'a`b',
    'a^b',
    'a%PATH%b',
    'a\nb',
    'a b',
    '',
  ])('rejects %j', (arg) => {
    expect(() => assertSafeArg(arg)).toThrow();
  });

  it.each(['--global', 'Git.Git', '@scope/pkg@latest', 'imagemagick.app', '--format=json'])(
    'accepts %j',
    (arg) => {
      expect(() => assertSafeArg(arg)).not.toThrow();
    },
  );
});

describe('isSafePackageId', () => {
  it.each(['Git.Git', 'imagemagick.app', '@scope/pkg', 'XP8K4RGX25G3GM', 'stable-x86_64-pc-windows-msvc'])(
    'accepts %j',
    (id) => {
      expect(isSafePackageId(id)).toBe(true);
    },
  );

  it.each(['', '  ', 'a b', 'a&b', '-leading-dash', '../../etc', 'a;b', 'a|b'])(
    'rejects %j',
    (id) => {
      expect(isSafePackageId(id)).toBe(false);
    },
  );
});

describe('displayCommand', () => {
  it('shows the basename and quotes only what needs it', () => {
    expect(displayCommand('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--global', 'a'])).toBe(
      'npm.cmd install --global a',
    );
  });
});

// ── encoding detection ────────────────────────────────────────────────────────────────────────

describe('sniffEncoding', () => {
  it('detects a UTF-8 BOM and reports it should be skipped', () => {
    expect(sniffEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({
      encoding: 'utf-8',
      skip: 3,
    });
  });

  it('detects a UTF-16LE BOM', () => {
    expect(sniffEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({
      encoding: 'utf-16le',
      skip: 2,
    });
  });

  it('detects BOM-less UTF-16LE from its zero bytes', () => {
    const utf16 = Buffer.from('Name  Id  Version', 'utf16le');
    expect(sniffEncoding(utf16).encoding).toBe('utf-16le');
  });

  it('treats ordinary ASCII as UTF-8', () => {
    expect(sniffEncoding(Buffer.from('Name  Id  Version', 'utf8'))).toEqual({
      encoding: 'utf-8',
      skip: 0,
    });
  });

  it('does not mistake real UTF-8 output for UTF-16', () => {
    expect(sniffEncoding(Buffer.from(fixture('choco-outdated.txt'), 'utf8')).encoding).toBe('utf-8');
  });
});

// ── regressions from the 229-package run on 2026-08-01 ────────────────────────────────────────

describe('classifyStderr (rustup writes all its progress to stderr)', () => {
  it.each([
    'info: removing previous version of component cargo',
    'info: downloading 7 components',
    'Collecting filelock',
    '  Downloading filelock-3.32.2-py3-none-any.whl (16 kB)',
    'added 3 packages in 3s',
  ])('does not paint %j as an error', (line) => {
    expect(classifyStderr(line)).toBe('stdout');
  });

  it.each(['warning: unused manifest key', 'WARN deprecated package@1.0.0'])(
    'treats %j as a warning',
    (line) => {
      expect(classifyStderr(line)).toBe('warn');
    },
  );

  it.each([
    'ERROR: Could not install packages due to an OSError',
    'fatal: unable to access repository',
    'error: failed to compile',
    'Access is denied',
  ])('keeps %j as an error', (line) => {
    expect(classifyStderr(line)).toBe('stderr');
  });
});

describe('hasLocalVersion (the torch +cu118 trap)', () => {
  it.each(['2.0.1+cu118', '0.15.2+cu118', '1.2.3+local.build', '2.5.0+rocm6.1'])(
    'flags %j as a custom-index build',
    (v) => {
      expect(hasLocalVersion(v)).toBe(true);
    },
  );

  it.each(['2.13.0', '1.23.5', '26.2', '7.1.2.2400', 'Unknown', ''])(
    'does not flag %j',
    (v) => {
      expect(hasLocalVersion(v)).toBe(false);
    },
  );
});

describe('buildItem marks custom-index builds', () => {
  it('flags torch 2.0.1+cu118 -> 2.13.0 as local', () => {
    const item = buildItem({
      provider: 'pip',
      environment: '3.10',
      id: 'torch',
      current: '2.0.1+cu118',
      available: '2.13.0',
      source: 'Python 3.10 · user',
    });
    // This is the row that silently replaced a CUDA build with a CPU one.
    expect(item?.local).toBe(true);
  });

  it('does not flag a package that keeps its local segment', () => {
    const item = buildItem({
      provider: 'pip',
      environment: '3.10',
      id: 'torch',
      current: '2.0.1+cu118',
      available: '2.1.0+cu118',
    });
    expect(item?.local).toBe(false);
  });

  it('does not flag an ordinary upgrade', () => {
    const item = buildItem({
      provider: 'pip',
      environment: '3.10',
      id: 'anyio',
      current: '3.7.1',
      available: '4.14.2',
    });
    expect(item?.local).toBe(false);
  });

  it('keeps the environment in the key and the source so two interpreters do not collide', () => {
    // Two rows for `mpmath 1.3.0 → 1.4.1` appeared identical on screen because the table rendered the
    // provider instead of the source. The data was always distinct; only the display was wrong.
    const a = buildItem({
      provider: 'pip',
      environment: '3.13',
      id: 'mpmath',
      current: '1.3.0',
      available: '1.4.1',
      source: 'Python 3.13 · system',
    });
    const b = buildItem({
      provider: 'pip',
      environment: '3.10',
      id: 'mpmath',
      current: '1.3.0',
      available: '1.4.1',
      source: 'Python 3.10 · user',
    });
    expect(a!.key).not.toBe(b!.key);
    expect(a!.source).not.toBe(b!.source);
  });
});

// ── skip rules and broken-shortcut detection ──────────────────────────────────────────────────

describe('skip rules', () => {
  const torch = buildItem({
    provider: 'pip', environment: '3.10', id: 'torch',
    current: '2.0.1', available: '2.13.0',
  })!;
  const epic = buildItem({
    provider: 'winget', id: 'EpicGames.EpicGamesLauncher', name: 'Epic Games Launcher',
    current: '1.3.176.0', available: '1.3.193.0',
  })!;

  it('skips forever regardless of version', () => {
    const forever: SkipRule = { key: 'winget:EpicGames.EpicGamesLauncher', version: null, name: 'Epic', at: 0 };
    expect(isSkipped(epic, [forever])).toBe(true);
  });

  it('skips only the named version, so a newer one comes back', () => {
    const oneVersion: SkipRule = {
      key: 'winget:EpicGames.EpicGamesLauncher', version: '1.3.193.0', name: 'Epic', at: 0,
    };
    expect(isSkipped(epic, [oneVersion])).toBe(true);

    const newer = { ...epic, availableVersion: '1.3.200.0' };
    expect(isSkipped(newer, [oneVersion])).toBe(false);
  });

  it('does not leak across packages', () => {
    const rule: SkipRule = { key: 'winget:EpicGames.EpicGamesLauncher', version: null, name: 'Epic', at: 0 };
    expect(isSkipped(torch, [rule])).toBe(false);
  });

  it('matches on provider:id so every environment is covered by one rule', () => {
    const rule: SkipRule = { key: 'pip:torch', version: null, name: 'torch', at: 0 };
    const other = { ...torch, environment: '3.13', key: 'pip:3.13:torch' };
    expect(isSkipped(torch, [rule])).toBe(true);
    expect(isSkipped(other, [rule])).toBe(true);
  });

  it('ignores an empty rule set', () => {
    expect(isSkipped(epic, [])).toBe(false);
  });
});

describe('settings normalisation of skip rules', () => {
  it('seeds Epic Games Launcher when the key is absent (older settings file)', () => {
    const s = normaliseSettings({ scanOnLaunch: true });
    expect(s.skipped.some((r) => r.key === 'winget:EpicGames.EpicGamesLauncher' && r.version === null)).toBe(true);
  });

  it('preserves a deliberately empty list rather than re-seeding it', () => {
    // Someone who removed the default must not have it reappear on next launch.
    expect(normaliseSettings({ skipped: [] }).skipped).toEqual([]);
  });

  it('discards junk entries and keeps valid ones', () => {
    const s = normaliseSettings({
      skipped: [null, 42, { version: '1' }, { key: '' }, { key: 'winget:A', version: '2', name: 'A' }],
    });
    expect(s.skipped).toHaveLength(1);
    expect(s.skipped[0]).toMatchObject({ key: 'winget:A', version: '2', name: 'A' });
  });

  it('de-duplicates identical rules', () => {
    const s = normaliseSettings({
      skipped: [
        { key: 'winget:A', version: null, name: 'A' },
        { key: 'winget:A', version: null, name: 'A' },
      ],
    });
    expect(s.skipped).toHaveLength(1);
  });

  it('keeps a forever rule and a version rule for the same package as distinct entries', () => {
    const s = normaliseSettings({
      skipped: [
        { key: 'winget:A', version: '2', name: 'A' },
        { key: 'winget:A', version: null, name: 'A' },
      ],
    });
    expect(s.skipped).toHaveLength(2);
    // Forever sorts first so the settings list reads sensibly.
    expect(s.skipped[0]!.version).toBeNull();
  });
});

describe('diffBrokenShortcuts', () => {
  const census = (...rows: Array<[string, string, boolean]>) =>
    new Map(rows.map(([lnk, target, ok]) => [lnk.toLowerCase(), { lnk, name: lnk, target, ok }]));

  it('reports a shortcut that worked before and not after — the Epic case', () => {
    const before = census(['C:\\Epic.lnk', 'C:\\old\\Epic.exe', true]);
    const after = census(['C:\\Epic.lnk', 'C:\\old\\Epic.exe', false]);
    expect(diffBrokenShortcuts(before, after)).toEqual([
      { shortcut: 'C:\\Epic.lnk', name: 'C:\\Epic.lnk', target: 'C:\\old\\Epic.exe' },
    ]);
  });

  it('ignores shortcuts that were already broken', () => {
    const before = census(['C:\\Old.lnk', 'C:\\gone.exe', false]);
    const after = census(['C:\\Old.lnk', 'C:\\gone.exe', false]);
    expect(diffBrokenShortcuts(before, after)).toEqual([]);
  });

  it('ignores a shortcut that was removed entirely (a clean uninstall)', () => {
    const before = census(['C:\\Gone.lnk', 'C:\\app.exe', true]);
    expect(diffBrokenShortcuts(before, new Map())).toEqual([]);
  });

  it('ignores a brand-new broken shortcut it cannot attribute', () => {
    const after = census(['C:\\New.lnk', 'C:\\missing.exe', false]);
    expect(diffBrokenShortcuts(new Map(), after)).toEqual([]);
  });

  it('says nothing when everything still resolves', () => {
    const c = census(['C:\\A.lnk', 'C:\\a.exe', true], ['C:\\B.lnk', 'C:\\b.exe', true]);
    expect(diffBrokenShortcuts(c, c)).toEqual([]);
  });
});
