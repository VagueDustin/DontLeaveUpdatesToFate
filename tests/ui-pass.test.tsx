/**
 * ui-pass.test.tsx: bugs found driving the real 1.7.0 app on a Mac.
 */

import './renderer-env.js';
import { describe, expect, it } from 'vitest';

import { compactPath } from '../src/shared/format.js';
import { newestPatchPerMinor, parseUvPythonList } from '../src/main/providers/uv.js';
import { macEnvironmentLabel } from '../src/main/providers/pip.js';
import { masLocationQuery } from '../src/main/providers/mas.js';
import { quietFailure } from '../src/main/providers/util.js';
import { providerLabel } from '../src/renderer/src/state/app.js';

describe('compactPath', () => {
  it('shortens a two-folder path that does not fit, instead of leaving it to be cut off', () => {
    expect(compactPath('/Applications/Windows App.app', 20)).toBe('…/Windows App.app');
  });
});

describe('uv Pythons after an upgrade', () => {
  it('stops offering an upgrade once the newer patch is installed, even though uv keeps the old one', () => {
    const dir = '/Users/dev/.local/share/uv/python';
    const installed = parseUvPythonList(
      `cpython-3.12.15-macos-aarch64-none    ${dir}/cpython-3.12-macos-aarch64-none/bin/python3.12\n` +
        `cpython-3.12.14-macos-aarch64-none    ${dir}/cpython-3.12.14-macos-aarch64-none/bin/python3.12\n`,
      dir,
    );
    const downloads = parseUvPythonList('cpython-3.12.15-macos-aarch64-none    <download available>\n', dir);
    expect(newestPatchPerMinor(installed, downloads)).toEqual([]);
  });
});

describe('two uv Pythons of the same minor', () => {
  it('are labelled with their full version', () => {
    expect(
      macEnvironmentLabel({ tag: 'uv-3.12', path: '/Users/dev/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none/bin/python3.12' }),
    ).toBe('Python 3.12.14 · uv');
  });
});

describe('App Store app locations', () => {
  it('are looked up by App Store id, since the app name can differ (Kindle is "Amazon Kindle.app")', () => {
    expect(masLocationQuery('302584613')).toEqual(['kMDItemAppStoreAdamID == 302584613']);
  });
});

describe('exit code 1 from npm outdated', () => {
  it('is not reported as a failure, because it means "found something"', () => {
    expect(quietFailure({ code: 1, stdout: '{"x":{}}', stderr: '' } as never, [0, 1])).toBeNull();
    expect(quietFailure({ code: 2, stdout: '', stderr: 'boom' } as never, [0, 1])).toBe('boom');
  });
});

describe('the manager filter chip', () => {
  it('names the manager, not its internal id', () => {
    expect(providerLabel('mas', [{ id: 'mas', label: 'App Store' } as never])).toBe('App Store');
    expect(providerLabel('npm', [])).toBe('npm');
  });
});
