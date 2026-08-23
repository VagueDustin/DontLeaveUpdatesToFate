/**
 * locations.test.ts — the "where is this installed?" machinery.
 *
 * Everything here is pure. The parts that touch the disk or spawn PowerShell are covered by the
 * integration suite; what is tested here is the reasoning applied to whatever those return, because
 * that is where a wrong answer is both plausible and silent — a path that looks right, points
 * somewhere else, and sends the user to the wrong folder with total confidence.
 */

import { describe, expect, it } from 'vitest';

import {
  ancestorOf,
  directoryFromIcon,
  directoryFromUninstallString,
  expandEnv,
  isSystemPath,
  safeJoin,
} from '../src/main/paths.js';
import { buildIndex, looseName, lookup, normaliseName } from '../src/main/registry.js';
import { compactPath } from '../src/shared/format.js';
import { parseWingetUpgrade } from '../src/main/providers/winget.js';
import { parseChocoOutdated } from '../src/main/providers/chocolatey.js';
import { distributionKey } from '../src/main/providers/pip.js';
import { __test as nodeTest } from '../src/main/providers/node.js';
import { buildItem } from '../src/main/providers/util.js';

describe('expandEnv', () => {
  it('expands a variable that is set', () => {
    process.env.FATE_TEST_ROOT = 'C:\\Fate';
    expect(expandEnv('%FATE_TEST_ROOT%\\App')).toBe('C:\\Fate\\App');
    delete process.env.FATE_TEST_ROOT;
  });

  it('leaves a variable that is not set alone rather than producing a broken path', () => {
    expect(expandEnv('%FATE_NOT_SET_ANYWHERE%\\App')).toBe('%FATE_NOT_SET_ANYWHERE%\\App');
  });

  it('passes through a path with no variables', () => {
    expect(expandEnv('C:\\Program Files\\Git')).toBe('C:\\Program Files\\Git');
  });
});

describe('isSystemPath', () => {
  it('recognises the Windows directory', () => {
    expect(isSystemPath('C:\\Windows\\System32\\msiexec.exe')).toBe(true);
  });

  it('does not treat an app that merely starts with the same letters as a system path', () => {
    expect(isSystemPath('C:\\WindowsApps\\Something')).toBe(false);
  });

  it('accepts a normal install', () => {
    expect(isSystemPath('C:\\Program Files\\obs-studio')).toBe(false);
  });
});

describe('directoryFromIcon', () => {
  it('drops the icon index', () => {
    expect(directoryFromIcon('C:\\Program Files\\App\\app.exe,0')).toBe('C:\\Program Files\\App');
  });

  it('drops surrounding quotes', () => {
    expect(directoryFromIcon('"C:\\Program Files\\App\\app.exe"')).toBe('C:\\Program Files\\App');
  });

  it('handles a negative resource index', () => {
    expect(directoryFromIcon('C:\\App\\app.exe,-101')).toBe('C:\\App');
  });

  it('keeps a comma that is part of the folder name', () => {
    expect(directoryFromIcon('C:\\Sam, Inc\\app.exe')).toBe('C:\\Sam, Inc');
  });

  it('refuses an icon that lives in the Windows directory', () => {
    expect(directoryFromIcon('C:\\Windows\\System32\\shell32.dll,3')).toBeNull();
  });

  it('refuses a relative path', () => {
    expect(directoryFromIcon('app.exe,0')).toBeNull();
  });

  it('refuses an empty value', () => {
    expect(directoryFromIcon('   ')).toBeNull();
  });
});

describe('directoryFromUninstallString', () => {
  it('reads a quoted uninstaller', () => {
    expect(directoryFromUninstallString('"C:\\Program Files\\obs-studio\\uninstall.exe"')).toBe(
      'C:\\Program Files\\obs-studio',
    );
  });

  it('reads an unquoted uninstaller whose path contains spaces', () => {
    expect(directoryFromUninstallString('C:\\Program Files\\Bambu Studio\\Uninstall.exe')).toBe(
      'C:\\Program Files\\Bambu Studio',
    );
  });

  it('ignores arguments after the program', () => {
    expect(
      directoryFromUninstallString('"C:\\Program Files\\Google\\Play Games\\Uninstaller.exe" /o{GUID}'),
    ).toBe('C:\\Program Files\\Google\\Play Games');
  });

  /**
   * The one that matters. Every MSI product uninstalls through msiexec, so accepting this would give
   * `C:\Windows\System32` as the "install location" of a large fraction of installed software.
   */
  it('refuses msiexec', () => {
    expect(directoryFromUninstallString('MsiExec.exe /X{0788B172-EA4C-4BB2-B6DE-CF425BDFA8A7}')).toBeNull();
  });

  it('refuses a command that is not a path at all', () => {
    expect(directoryFromUninstallString('winget uninstall --product-code DenoLand.Deno')).toBeNull();
  });
});

describe('safeJoin', () => {
  it('joins a manager root and a package name', () => {
    expect(safeJoin('C:\\ProgramData\\chocolatey', 'lib', 'ffmpeg')).toBe(
      'C:\\ProgramData\\chocolatey\\lib\\ffmpeg',
    );
  });

  it('refuses a traversal', () => {
    expect(safeJoin('C:\\ProgramData\\chocolatey', 'lib', '..\\..\\Windows')).toBeNull();
  });

  it('refuses a separator inside a segment', () => {
    expect(safeJoin('C:\\scoop', 'apps', 'evil/name')).toBeNull();
    expect(safeJoin('C:\\scoop', 'apps', 'evil\\name')).toBeNull();
  });

  it('refuses a drive letter inside a segment', () => {
    expect(safeJoin('C:\\scoop', 'apps', 'D:')).toBeNull();
  });

  it('refuses an empty segment', () => {
    expect(safeJoin('C:\\scoop', 'apps', '')).toBeNull();
  });
});

describe('ancestorOf', () => {
  it('walks up the requested number of levels', () => {
    expect(ancestorOf('C:\\ProgramData\\chocolatey\\bin\\choco.exe', 2)).toBe(
      'C:\\ProgramData\\chocolatey',
    );
  });
});

describe('registry name matching', () => {
  it('normalises case and runs of whitespace', () => {
    expect(normaliseName('  GOG   GALAXY  ')).toBe('gog galaxy');
  });

  it('strips an architecture suffix', () => {
    expect(looseName('GOG GALAXY (64-bit)')).toBe('gog galaxy');
    expect(looseName('Microsoft Visual Studio Code (User)')).toBe('microsoft visual studio code');
  });

  it('strips a trailing version, with or without a dash', () => {
    expect(looseName('CPUID CPU-Z 2.20')).toBe('cpuid cpu-z');
    expect(looseName('Microsoft .NET Runtime - 8.0.29 (x64)')).toBe('microsoft .net runtime');
    expect(looseName('Comfy Desktop 1.0.34')).toBe('comfy desktop');
  });

  it('leaves a name with no decoration alone', () => {
    expect(looseName('OBS Studio')).toBe('obs studio');
  });

  it('refuses to reduce a name to almost nothing', () => {
    expect(looseName('Go 1.22')).toBeNull();
  });

  /**
   * The version in winget's Name column is the version being REPLACED, so it stops matching the
   * registry the instant the upgrade lands. Loose matching is what keeps a re-scan from losing every
   * location it had a moment ago.
   */
  it('matches a registry entry whose version has moved on', () => {
    const index = buildIndex([{ name: 'CPUID CPU-Z 2.21', location: 'C:\\Program Files\\CPUID\\CPU-Z' }]);
    expect(lookup(index, 'CPUID CPU-Z 2.20')).toBe('C:\\Program Files\\CPUID\\CPU-Z');
  });

  it('prefers an exact match over a loose one', () => {
    const index = buildIndex([
      { name: 'Python 3.13.14 (64-bit)', location: 'C:\\Python313' },
      { name: 'Python 3.14.6 (64-bit)', location: 'C:\\Python314' },
    ]);
    expect(lookup(index, 'Python 3.14.6 (64-bit)')).toBe('C:\\Python314');
  });

  /**
   * Three .NET runtimes differing only by version all reduce to the same loose key. Answering with
   * whichever happened to be enumerated first would send someone to the wrong folder and look
   * authoritative doing it, so the key is dropped instead.
   */
  it('answers with nothing when two different apps share a loose name', () => {
    const index = buildIndex([
      { name: 'Microsoft .NET Runtime - 8.0.30 (x64)', location: 'C:\\dotnet\\8' },
      { name: 'Microsoft .NET Runtime - 9.0.19 (x64)', location: 'C:\\dotnet\\9' },
    ]);
    expect(lookup(index, 'Microsoft .NET Runtime - 8.0.29 (x64)')).toBeNull();
  });

  it('keeps the loose key when duplicates agree on the location', () => {
    const index = buildIndex([
      { name: 'Thing 1.0', location: 'C:\\Thing' },
      { name: 'Thing 1.1', location: 'c:\\thing' },
    ]);
    expect(lookup(index, 'Thing 0.9')).toBe('C:\\Thing');
  });

  it('keeps the first writer on an exact collision, which is the machine-wide entry', () => {
    const index = buildIndex([
      { name: 'Shared App', location: 'C:\\Program Files\\Shared' },
      { name: 'Shared App', location: 'C:\\Users\\Vague\\Shared' },
    ]);
    expect(lookup(index, 'Shared App')).toBe('C:\\Program Files\\Shared');
  });

  it('has no answer for a name it never saw', () => {
    expect(lookup(buildIndex([]), 'Nothing At All')).toBeNull();
  });
});

describe('compactPath', () => {
  // The budget is measured from the live column at render time; these pass it explicitly so each case
  // states the width it is about rather than depending on the fallback.
  const WIDE = 30;
  const NARROW = 13;

  it('keeps one parent segment when it fits', () => {
    expect(compactPath('C:\\Python313\\Lib\\site-packages\\torch', WIDE)).toBe(
      '…\\site-packages\\torch',
    );
    expect(compactPath('C:\\ProgramData\\chocolatey\\lib\\ffmpeg', WIDE)).toBe('…\\lib\\ffmpeg');
  });

  /**
   * The rule that matters. At the narrowest supported window the location column is thirteen
   * characters, and letting CSS truncate `…\site-packages\torch` produces `…\site-packa…` — the one
   * word that says which package this is, cut off. Dropping the parent instead keeps `torch`.
   */
  it('drops the parent rather than the leaf when the whole thing will not fit', () => {
    expect(compactPath('C:\\Python313\\Lib\\site-packages\\torch', NARROW)).toBe('…\\torch');
    expect(compactPath('C:\\Program Files\\obs-studio', NARROW)).toBe('…\\obs-studio');
    expect(compactPath('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher', 24)).toBe(
      '…\\Ubisoft Game Launcher',
    );
  });

  it('keeps a bare drive letter rather than spending two characters to hide three', () => {
    expect(compactPath('C:\\Program Files\\Git', WIDE)).toBe('C:\\Program Files\\Git');
  });

  it('drops even the drive letter when the budget is too tight for it', () => {
    expect(compactPath('C:\\Program Files\\Git', NARROW)).toBe('…\\Git');
  });

  it('leaves a short path alone whatever the budget', () => {
    expect(compactPath('C:\\Git', 4)).toBe('C:\\Git');
    expect(compactPath('torch', 2)).toBe('torch');
  });

  it('normalises forward slashes to Windows separators', () => {
    expect(compactPath('C:/Users/Vague/AppData/npm/tsx', WIDE)).toBe('…\\npm\\tsx');
  });

  it('collapses doubled separators rather than emitting empty segments', () => {
    expect(compactPath('C:\\\\a\\\\b\\\\c\\\\d', WIDE)).toBe('…\\c\\d');
  });

  it('returns an over-budget leaf rather than nothing, and lets CSS finish the job', () => {
    const deno =
      'C:\\Users\\V\\AppData\\Local\\Microsoft\\WinGet\\Packages\\DenoLand.Deno_Microsoft.Winget';
    expect(compactPath(deno, NARROW)).toBe('…\\DenoLand.Deno_Microsoft.Winget');
  });
});

describe('locations reaching the item', () => {
  it('is null when the adapter has nothing to say', () => {
    const item = buildItem({ provider: 'pip', id: 'six', current: '1.0', available: '1.1' });
    expect(item?.location).toBeNull();
  });

  it('is trimmed, and a blank string becomes null rather than an empty cell', () => {
    const blank = buildItem({
      provider: 'pip',
      id: 'six',
      current: '1.0',
      available: '1.1',
      location: '   ',
    });
    expect(blank?.location).toBeNull();

    const real = buildItem({
      provider: 'pip',
      id: 'six',
      current: '1.0',
      available: '1.1',
      location: '  C:\\py\\six.py  ',
    });
    expect(real?.location).toBe('C:\\py\\six.py');
  });

  it('is threaded through the winget table parser', () => {
    // Column starts must line up with the header: winget's table is fixed-width, not delimited.
    const lines = [
      'Name                  Id                    Version  Available  Source',
      '----------------------------------------------------------------------',
      'OBS Studio            OBSProject.OBSStudio  32.1.2   32.2.1     winget',
    ];
    const [item] = parseWingetUpgrade(lines, (name) =>
      name === 'OBS Studio' ? 'C:\\Program Files\\obs-studio' : null,
    );
    expect(item?.name).toBe('OBS Studio');
    expect(item?.location).toBe('C:\\Program Files\\obs-studio');
  });

  it('is threaded through the chocolatey row parser', () => {
    const [item] = parseChocoOutdated(['ffmpeg|8.1.2|9.0.1|false'], (id) =>
      id === 'ffmpeg' ? 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg' : null,
    );
    expect(item?.location).toBe('C:\\ProgramData\\chocolatey\\lib\\ffmpeg');
  });

  it('uses the location npm reports for itself', () => {
    const report = JSON.stringify({
      npm: {
        current: '11.17.0',
        latest: '12.0.2',
        location: 'C:\\Users\\Vague\\AppData\\Roaming\\npm\\node_modules\\npm',
      },
    });
    const [item] = nodeTest.parseOutdated('npm', report, null);
    expect(item?.location).toBe('C:\\Users\\Vague\\AppData\\Roaming\\npm\\node_modules\\npm');
  });

  /** pnpm's `outdated --json` has no location field, so the global root is joined with the name. */
  it('falls back to the global root when the manager does not report one', () => {
    const report = JSON.stringify({ tsx: { current: '4.0.0', latest: '4.1.0' } });
    const [item] = nodeTest.parseOutdated('pnpm', report, 'C:\\pnpm\\global\\node_modules');
    expect(item?.location).toBe('C:\\pnpm\\global\\node_modules\\tsx');
  });

  it('splits a scoped package into two path segments', () => {
    const report = JSON.stringify({ '@vaguedustin/brand': { current: '1.0.0', latest: '1.1.0' } });
    const [item] = nodeTest.parseOutdated('npm', report, 'C:\\npm\\node_modules');
    expect(item?.location).toBe('C:\\npm\\node_modules\\@vaguedustin\\brand');
  });

  it('ignores a relative location rather than showing a path that goes nowhere', () => {
    const report = JSON.stringify({ tsx: { current: '4.0.0', latest: '4.1.0', location: 'node_modules/tsx' } });
    const [item] = nodeTest.parseOutdated('npm', report, null);
    expect(item?.location).toBeNull();
  });
});

describe('distributionKey', () => {
  it('normalises the way pip does, so pip list and importlib.metadata agree', () => {
    expect(distributionKey('Pygments')).toBe('pygments');
    expect(distributionKey('typing_inspection')).toBe('typing-inspection');
    expect(distributionKey('zope.interface')).toBe('zope-interface');
    expect(distributionKey('  python-engineio ')).toBe('python-engineio');
  });
});
