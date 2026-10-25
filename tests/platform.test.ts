/**
 * platform.test.ts: the OS-specific layer, and the bits of output that depend on it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { platform } from '../src/main/platform/index.js';
import { macPlatform, parseSwVers } from '../src/main/platform/mac.js';
import { windowsPlatform } from '../src/main/platform/windows.js';
import { LogStore, type ExportMeta } from '../src/main/logstore.js';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('platform selection', () => {
  it('picks the implementation for the running OS', () => {
    expect(platform.id).toBe(process.platform === 'win32' ? 'windows' : 'mac');
  });

  it('windows elevation model is relaunch, mac is askpass', () => {
    expect(windowsPlatform.elevation.kind).toBe('relaunch');
    expect(macPlatform.elevation.kind).toBe('askpass');
  });
});

describe('parseSwVers', () => {
  it('reads product version and build from sw_vers', () => {
    expect(parseSwVers(fixture('sw-vers.txt'))).toBe('macOS 27.0.1 (26A434)');
  });

  it('falls back to a plain label when sw_vers says nothing useful', () => {
    expect(parseSwVers('')).toBe('macOS');
  });
});

const baseMeta: ExportMeta = {
  platform: 'windows',
  appVersion: '1.7.0',
  electronVersion: '43.7.9',
  osVersion: 'win32 10.0.26100',
  elevated: false,
  adminPrompts: null,
  providers: [],
  packages: [],
  updated: 0,
  failed: 0,
  skipped: 0,
};

describe('export header by platform', () => {
  const store = new LogStore(() => undefined);

  it('keeps the Windows header exactly as it was', () => {
    const text = store.export('txt', baseMeta);
    expect(text).toContain('Windows      win32 10.0.26100');
    expect(text).toContain('Elevated     no');
  });

  it('names macOS and reports admin prompts instead of elevation on a Mac', () => {
    const meta: ExportMeta = {
      ...baseMeta,
      platform: 'mac',
      osVersion: 'macOS 27.0.1 (26A434)',
      adminPrompts: { shown: 2, declined: 1 },
    };
    const text = store.export('txt', meta);
    expect(text).toContain('macOS        macOS 27.0.1 (26A434)');
    expect(text).toContain('Admin        2 prompts, 1 declined');
    expect(text).not.toContain('Elevated');

    const md = store.export('md', meta);
    expect(md).toContain('| macOS | macOS 27.0.1 (26A434) |');
    expect(md).toContain('| Admin | 2 prompts, 1 declined |');

    const json = JSON.parse(store.export('json', meta)) as { environment: Record<string, unknown> };
    expect(json.environment.platform).toBe('mac');
    expect(json.environment.adminPrompts).toEqual({ shown: 2, declined: 1 });
  });
});
