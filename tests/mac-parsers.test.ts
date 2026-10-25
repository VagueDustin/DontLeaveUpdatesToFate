/**
 * mac-parsers.test.ts: the macOS providers' parsers, against output captured from real Macs.
 *
 * Fixtures come from this machine and from a GitHub macOS runner (see
 * .github/workflows/capture-mac-fixtures.yml); usernames in paths are replaced with `dev`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BREW_ENV, caskAppPaths, parseBrewOutdated } from '../src/main/providers/brew.js';
import { buildItem } from '../src/main/providers/util.js';
import { newestPatchPerMinor, parseUvPythonList, parseUvToolOutdated } from '../src/main/providers/uv.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('parseBrewOutdated', () => {
  it('reads an empty report', () => {
    expect(parseBrewOutdated(readFixture('brew-outdated-empty.json'))).toEqual({ formulae: [], casks: [] });
  });

  it('tolerates progress lines before the JSON', () => {
    expect(parseBrewOutdated('==> Downloading Homebrew API data\n' + readFixture('brew-outdated-empty.json'))).toEqual({
      formulae: [],
      casks: [],
    });
  });

  it('returns nothing for output that is not brew JSON', () => {
    expect(parseBrewOutdated('Error: something went wrong')).toEqual({ formulae: [], casks: [] });
  });

  it('takes the newest installed version and the pin', () => {
    const json = JSON.stringify({
      formulae: [
        { name: 'node@22', installed_versions: ['22.1.0', '22.3.0'], current_version: '22.9.0', pinned: true, pinned_version: '22.3.0' },
      ],
      casks: [{ name: 'rectangle', installed_versions: ['0.80'], current_version: '0.85' }],
    });
    expect(parseBrewOutdated(json)).toEqual({
      formulae: [{ name: 'node@22', installed: '22.3.0', available: '22.9.0', pinned: true }],
      casks: [{ name: 'rectangle', installed: '0.80', available: '0.85', pinned: false }],
    });
  });

  it('accepts the older string form of a cask installed_versions', () => {
    const json = JSON.stringify({ formulae: [], casks: [{ name: 'pika', installed_versions: '1.9.0', current_version: '2.0.1' }] });
    expect(parseBrewOutdated(json).casks[0]).toMatchObject({ installed: '1.9.0', available: '2.0.1' });
  });
});

describe('brew package names', () => {
  it('keeps tap-qualified and versioned names intact', () => {
    for (const id of ['hashicorp/tap/terraform', 'node@22', 'python@3.13']) {
      const item = buildItem({ provider: 'brew', id, current: '1.0.0', available: '1.1.0' });
      expect(item?.id).toBe(id);
    }
  });
});

describe('caskAppPaths', () => {
  it('reads the app path of a cask', () => {
    expect(caskAppPaths(readFixture('brew-info-cask.json')).get('pika')).toBe('/Applications/Pika.app');
  });
});

describe('BREW_ENV', () => {
  it('keeps brew from updating itself or printing hints during a scan', () => {
    expect(BREW_ENV).toEqual({
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1',
      HOMEBREW_NO_INSTALL_CLEANUP: '1',
    });
  });
});

describe('parseUvToolOutdated', () => {
  it('reads each outdated tool and skips its entry-point lines', () => {
    expect(parseUvToolOutdated(readFixture('uv-tool-outdated.txt'))).toEqual([
      { name: 'httpie', installed: '3.2.3', available: '3.2.4' },
      { name: 'ruff', installed: '0.14.0', available: '0.17.2' },
    ]);
  });

  it('reads nothing from "No tools installed"', () => {
    expect(parseUvToolOutdated('No tools installed\n')).toEqual([]);
  });
});

describe('uv Pythons', () => {
  const pythonDir = '/Users/dev/.local/share/uv/python';

  it('marks only installs under uv python dir as managed', () => {
    const list = parseUvPythonList(readFixture('uv-python-list.txt'), pythonDir);
    expect(list.map((p) => [p.version, p.managed])).toEqual([
      ['3.12.14', true],
      ['3.9.6', false],
    ]);
  });

  it('offers the newest patch of the same minor, same build flavour', () => {
    const installed = parseUvPythonList(readFixture('uv-python-list.txt'), pythonDir);
    const downloads = parseUvPythonList(readFixture('uv-python-downloads.txt'), pythonDir);
    expect(newestPatchPerMinor(installed, downloads)).toEqual([
      { minor: '3.12', installed: '3.12.14', available: '3.12.15', path: installed[0]!.path },
    ]);
  });

  it('ignores freethreaded, PyPy and GraalPy builds when matching CPython', () => {
    const installed = parseUvPythonList(
      'cpython-3.13.1-macos-aarch64-none    /Users/dev/.local/share/uv/python/cpython-3.13-macos-aarch64-none/bin/python3.13\n',
      pythonDir,
    );
    const downloads = parseUvPythonList(
      'cpython-3.13.9+freethreaded-macos-aarch64-none    <download available>\npypy-3.13.5-macos-aarch64-none    <download available>\ncpython-3.13.4-macos-aarch64-none    <download available>\n',
      pythonDir,
    );
    expect(newestPatchPerMinor(installed, downloads).map((u) => u.available)).toEqual(['3.13.4']);
  });
});
