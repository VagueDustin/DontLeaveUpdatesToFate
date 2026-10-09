/**
 * pip-upgrade.test.ts: a package is upgraded in the Python it was found in, or not at all.
 *
 * The upgrade used to fall back to the first interpreter when the item's environment had gone missing
 * between the scan and the run (a Python uninstalled, or dropped from the launcher's list), which put
 * the upgrade into a different Python entirely.
 *
 * Nothing is spawned: the refusal happens before any command is built, and the interpreter paths are
 * fake.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderInfo, UpdateItem } from '../src/shared/types.js';
import { pipProvider } from '../src/main/providers/pip.js';
import type { ProviderRuntime } from '../src/main/providers/types.js';

const info: ProviderInfo = {
  id: 'pip',
  label: 'pip',
  command: 'pip',
  kind: 'language',
  blurb: '',
  available: true,
  binary: 'C:\\stub\\Python313\\python.exe',
  version: '25.0',
  unavailable: null,
  unavailableDetail: null,
  needsElevation: false,
  environments: [{ id: '3.13', label: 'Python 3.13 · system', path: 'C:\\stub\\Python313\\python.exe' }],
};

const torch: UpdateItem = {
  key: 'pip:3.10:torch',
  provider: 'pip',
  environment: '3.10',
  id: 'torch',
  name: 'torch',
  currentVersion: '2.0.1',
  availableVersion: '2.13.0',
  source: 'Python 3.10 · user',
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
};

const runtime: ProviderRuntime = {
  signal: new AbortController().signal,
  timeoutMs: 1000,
  emit: () => undefined,
  emitStream: () => undefined,
};

describe('pip upgrade', () => {
  it('refuses rather than upgrading in another Python when the environment has gone', async () => {
    await expect(pipProvider.upgrade(torch, info, runtime)).rejects.toThrow(
      /Python 3\.10 · user is no longer installed/,
    );
  });
});
