/**
 * release.test.ts: the self-update decision logic.
 *
 * The failure modes here are quiet and expensive. Offering the wrong artifact converts a portable
 * user into an installed one behind their back. Matching a checksum against the wrong filename passes
 * a corrupted download. Getting the version comparison backwards nags forever, or never mentions an
 * update at all. None of those announce themselves, so they are all pinned here against the real
 * payload shape returned by `api.github.com/repos/.../releases/latest`.
 */

import { describe, expect, it } from 'vitest';

import {
  assetFor,
  checksumsIn,
  describe as describeRelease,
  digestFor,
  isNewer,
  parseRelease,
  versionFromTag,
  type Asset,
  __test as pruneTest,
} from '../src/main/release.js';

/** Captured verbatim from the v1.1.0 release of this project. */
const PAYLOAD = {
  tag_name: 'v1.1.0',
  name: '1.1.0, Where it is, on disk',
  draft: false,
  prerelease: false,
  published_at: '2026-08-23T05:40:51Z',
  html_url: 'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/tag/v1.1.0',
  assets: [
    {
      name: 'DontLeaveUpdatesToFate-1.1.0-portable.exe',
      size: 102634599,
      browser_download_url:
        'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/download/v1.1.0/DontLeaveUpdatesToFate-1.1.0-portable.exe',
    },
    {
      name: 'DontLeaveUpdatesToFate-1.1.0-setup.exe',
      size: 102970578,
      browser_download_url:
        'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/download/v1.1.0/DontLeaveUpdatesToFate-1.1.0-setup.exe',
    },
    {
      name: 'SHA256SUMS-1.1.0.txt',
      size: 215,
      browser_download_url:
        'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/download/v1.1.0/SHA256SUMS-1.1.0.txt',
    },
  ],
};

describe('versionFromTag', () => {
  it('strips the tag prefix', () => {
    expect(versionFromTag('v1.1.0')).toBe('1.1.0');
    expect(versionFromTag('V2.0.0')).toBe('2.0.0');
    expect(versionFromTag('1.1.0')).toBe('1.1.0');
    expect(versionFromTag('  v1.1.0  ')).toBe('1.1.0');
  });
});

describe('parseRelease', () => {
  it('reads the real payload', () => {
    const release = parseRelease(PAYLOAD)!;
    expect(release.version).toBe('1.1.0');
    expect(release.name).toBe('1.1.0, Where it is, on disk');
    expect(release.publishedAt).toBe('2026-08-23T05:40:51Z');
    expect(release.assets).toHaveLength(3);
  });

  it('refuses a draft or a prerelease', () => {
    expect(parseRelease({ ...PAYLOAD, draft: true })).toBeNull();
    expect(parseRelease({ ...PAYLOAD, prerelease: true })).toBeNull();
  });

  it('refuses a tag that is not a version', () => {
    expect(parseRelease({ ...PAYLOAD, tag_name: 'nightly' })).toBeNull();
    expect(parseRelease({ ...PAYLOAD, tag_name: '' })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease('v1.1.0')).toBeNull();
    expect(parseRelease([])).toBeNull();
  });

  /**
   * The one that matters for safety. A download URL is fetched and then EXECUTED, so a payload that
   * points anywhere but GitHub's own release host must contribute no asset at all.
   */
  it('drops an asset whose download URL is not on github.com', () => {
    const release = parseRelease({
      ...PAYLOAD,
      assets: [
        { name: 'evil-setup.exe', size: 10, browser_download_url: 'https://example.com/evil.exe' },
        { name: 'evil2-setup.exe', size: 10, browser_download_url: 'http://github.com/x' },
        PAYLOAD.assets[1],
      ],
    })!;
    expect(release.assets.map((a) => a.name)).toEqual(['DontLeaveUpdatesToFate-1.1.0-setup.exe']);
  });

  it('falls back to a sane name and notes URL when the release has neither', () => {
    const release = parseRelease({ ...PAYLOAD, name: '   ', html_url: 'javascript:alert(1)' })!;
    expect(release.name).toBe('Version 1.1.0');
    expect(release.notesUrl).toBe('https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases');
  });

  it('tolerates a release with no assets', () => {
    const release = parseRelease({ ...PAYLOAD, assets: undefined })!;
    expect(release.assets).toEqual([]);
  });
});

describe('assetFor', () => {
  const assets = parseRelease(PAYLOAD)!.assets;

  /**
   * Handing an installed user the portable exe leaves them with a second, unmanaged copy; handing a
   * portable user the installer silently converts their "installs nothing" choice into an install.
   */
  it('gives each build kind its own artifact', () => {
    expect(assetFor(assets, 'portable')!.name).toBe('DontLeaveUpdatesToFate-1.1.0-portable.exe');
    expect(assetFor(assets, 'installed')!.name).toBe('DontLeaveUpdatesToFate-1.1.0-setup.exe');
  });

  it('never mistakes the checksums file for a build', () => {
    const only: Asset[] = [{ name: 'SHA256SUMS-1.1.0.txt', size: 1, url: 'https://github.com/x' }];
    expect(assetFor(only, 'portable')).toBeNull();
    expect(assetFor(only, 'installed')).toBeNull();
  });

  it('has no answer when the release omits this build kind', () => {
    const setupOnly = assets.filter((a) => a.name.endsWith('-setup.exe'));
    expect(assetFor(setupOnly, 'portable')).toBeNull();
  });

  it('finds the checksums file', () => {
    expect(checksumsIn(assets)!.name).toBe('SHA256SUMS-1.1.0.txt');
    expect(checksumsIn(assets.filter((a) => a.name.endsWith('.exe')))).toBeNull();
  });
});

describe('digestFor', () => {
  const SUMS = [
    '1b6e93f78e358b7a31b58fb5fc5c9411676ddb6cb842b684b318adb3e2c81433  DontLeaveUpdatesToFate-1.1.0-portable.exe',
    '16ddb0076abb6809b0771986de8fc00eb31093cbfe4ef302a013782bc0c1c628  DontLeaveUpdatesToFate-1.1.0-setup.exe',
    '',
  ].join('\n');

  /**
   * Matched by filename, not by position. Taking the first line would happily verify the installer
   * against the portable build's hash and pass a file that is not what it claims to be.
   */
  it('picks the digest belonging to the named file', () => {
    expect(digestFor(SUMS, 'DontLeaveUpdatesToFate-1.1.0-setup.exe')).toBe(
      '16ddb0076abb6809b0771986de8fc00eb31093cbfe4ef302a013782bc0c1c628',
    );
    expect(digestFor(SUMS, 'DontLeaveUpdatesToFate-1.1.0-portable.exe')).toBe(
      '1b6e93f78e358b7a31b58fb5fc5c9411676ddb6cb842b684b318adb3e2c81433',
    );
  });

  it('has no answer for a file the list does not mention', () => {
    expect(digestFor(SUMS, 'something-else.exe')).toBeNull();
  });

  it('accepts the binary-mode asterisk that sha256sum writes', () => {
    expect(digestFor(`${'a'.repeat(64)} *thing.exe`, 'thing.exe')).toBe('a'.repeat(64));
  });

  it('ignores a line whose hash is the wrong length', () => {
    expect(digestFor('deadbeef  thing.exe', 'thing.exe')).toBeNull();
  });

  it('ignores commentary around the list', () => {
    const noisy = `# generated by the release job\n${'b'.repeat(64)}  thing.exe\n`;
    expect(digestFor(noisy, 'thing.exe')).toBe('b'.repeat(64));
  });
});

describe('isNewer', () => {
  it('offers a genuinely newer release', () => {
    expect(isNewer('1.1.0', '1.2.0')).toBe(true);
    expect(isNewer('1.1.0', '2.0.0')).toBe(true);
    expect(isNewer('1.0.9', '1.1.0')).toBe(true);
  });

  it('says nothing when this is the latest', () => {
    expect(isNewer('1.1.0', '1.1.0')).toBe(false);
  });

  /** A downgrade must never be offered, a rolled-back release would otherwise nag forever. */
  it('never offers a downgrade', () => {
    expect(isNewer('1.2.0', '1.1.0')).toBe(false);
    expect(isNewer('2.0.0', '1.9.9')).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    expect(isNewer('1.9.0', '1.10.0')).toBe(true);
    expect(isNewer('1.10.0', '1.9.0')).toBe(false);
  });

  it('stays quiet when one side is not a comparable version', () => {
    expect(isNewer('1.1.0', 'unknown')).toBe(false);
    expect(isNewer('', '1.1.0')).toBe(false);
  });
});

describe('describe', () => {
  it('reports the asset for the asking channel', () => {
    const release = parseRelease(PAYLOAD)!;
    expect(describeRelease(release, 'portable').assetName).toBe(
      'DontLeaveUpdatesToFate-1.1.0-portable.exe',
    );
    expect(describeRelease(release, 'installed').assetSize).toBe(102970578);
  });

  /** A dev run has no artifact of its own; the UI uses the null to say "check only". */
  it('has no asset for a dev build', () => {
    const release = parseRelease(PAYLOAD)!;
    expect(describeRelease(release, 'dev').assetName).toBeNull();
  });
});

describe('what the download directory cleanup is allowed to delete', () => {
  const { OURS } = pruneTest;

  /**
   * This pattern guards someone's Downloads folder. Downloads is where the installer has to land,
   * a hardened Windows will not execute anything from `%APPDATA%`, so the cleanup that removes a
   * superseded installer is running somewhere full of files that are none of its business.
   */
  it('matches the artifacts this app publishes', () => {
    expect(OURS.test('DontLeaveUpdatesToFate-1.2.0-setup.exe')).toBe(true);
    expect(OURS.test('DontLeaveUpdatesToFate-1.2.0-portable.exe')).toBe(true);
    expect(OURS.test('DontLeaveUpdatesToFate-10.0.1-setup.exe')).toBe(true);
  });

  it('refuses everything else in a Downloads folder', () => {
    for (const name of [
      'tax-return-2026.pdf',
      'DontLeaveUpdatesToFate-1.2.0-setup.exe.part',
      'SHA256SUMS-1.2.0.txt',
      'my-DontLeaveUpdatesToFate-1.2.0-setup.exe',
      'DontLeaveUpdatesToFate-setup.exe',
      'DontLeaveUpdatesToFate-1.2.0-installer.exe',
      'holiday.jpg',
      '.gitignore',
      'setup.exe',
    ]) {
      expect(OURS.test(name), `${name} must not be deletable`).toBe(false);
    }
  });
});
