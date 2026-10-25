import { describe, expect, it } from 'vitest';

import { providersFor } from '../src/main/providers/index.js';
import { normaliseSettings } from '../src/main/settings.js';

describe('providersFor', () => {
  it('orders Mac providers as the spec lists them', () => {
    expect(providersFor('darwin').map((p) => p.id)).toEqual([
      'brew',
      'brew-cask',
      'mas',
      'softwareupdate',
      'uv-tool',
      'uv-python',
      'npm',
      'pnpm',
      'pip',
      'cargo',
      'rustup',
    ]);
  });

  it('keeps the Windows list unchanged', () => {
    expect(providersFor('win32').map((p) => p.id)).toEqual([
      'winget',
      'chocolatey',
      'scoop',
      'npm',
      'pnpm',
      'pip',
      'cargo',
      'rustup',
    ]);
  });
});

describe('includeSelfUpdatingApps setting', () => {
  it('defaults to off, matching brew', () => {
    expect(normaliseSettings({}).includeSelfUpdatingApps).toBe(false);
  });

  it('keeps an explicit choice', () => {
    expect(normaliseSettings({ includeSelfUpdatingApps: true }).includeSelfUpdatingApps).toBe(true);
  });

  it('accepts the Mac provider ids in the disabled list', () => {
    expect(normaliseSettings({ disabledProviders: ['brew-cask', 'nope'] }).disabledProviders).toEqual(['brew-cask']);
  });
});
