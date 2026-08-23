/**
 * integration.test.ts — exercises the real machinery against the real system.
 *
 * Opt-in: these spawn actual package managers, so they are skipped unless FATE_INTEGRATION=1. Keeping
 * them out of the default `npm test` means the fast suite stays hermetic while the paths that only
 * break against a real process — streaming, timeouts, tree-kill, exit-code classification — still get
 * covered deliberately.
 *
 * Run with:  FATE_INTEGRATION=1 npx vitest run tests/integration.test.ts
 */

import { describe, expect, it } from 'vitest';
import { resolveBinary, runCommand } from '../src/main/exec.js';
import { providers } from '../src/main/providers/index.js';
import type { ProviderRuntime } from '../src/main/providers/types.js';
import type { ProviderInfo } from '../src/shared/types.js';

const ENABLED = process.env.FATE_INTEGRATION === '1';
const suite = ENABLED ? describe : describe.skip;

/** A runtime that collects everything instead of pushing it to a renderer. */
function harness(timeoutMs = 120_000): {
  rt: ProviderRuntime;
  lines: Array<{ text: string; level: string }>;
  abort: AbortController;
} {
  const abort = new AbortController();
  const lines: Array<{ text: string; level: string }> = [];
  return {
    abort,
    lines,
    rt: {
      signal: abort.signal,
      timeoutMs,
      emit: (text, level) => lines.push({ text, level }),
      emitStream: (text, stream) => lines.push({ text, level: stream }),
    },
  };
}

function infoFor(id: string, binary: string, environments: ProviderInfo['environments'] = []): ProviderInfo {
  const provider = providers.find((p) => p.id === id)!;
  return {
    id: provider.id,
    label: provider.label,
    command: provider.command,
    kind: provider.kind,
    blurb: provider.blurb,
    needsElevation: provider.needsElevation,
    available: true,
    binary,
    version: null,
    unavailable: null,
    unavailableDetail: null,
    environments,
  };
}

suite('the .cmd shim path', () => {
  it('runs npm through cmd.exe and gets a version back', async () => {
    const npm = await resolveBinary('npm');
    expect(npm).not.toBeNull();
    // The regression this guards: cmd /s /c strips the outer quote pair, so the command line needs
    // an extra wrapping pair or a path containing a space becomes two arguments.
    expect(npm!.toLowerCase()).toMatch(/\.cmd$/);

    const result = await runCommand({ file: npm!, args: ['--version'], timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

suite('probing every provider', () => {
  it('reports each manager as available or gives a reason', async () => {
    const results = await Promise.all(
      providers.map(async (provider) => ({
        id: provider.id,
        probe: await provider.probe(20_000),
      })),
    );

    for (const { id, probe } of results) {
      if (probe.available) {
        expect(probe.binary, `${id} available but no binary`).not.toBeNull();
      } else {
        // An unavailable provider must always explain itself — that text is shown in the sidebar.
        expect(probe.unavailable, `${id} unavailable with no reason`).not.toBeNull();
        expect(probe.unavailableDetail, `${id} unavailable with no detail`).toBeTruthy();
      }
    }

    // Sanity: this machine has these, so a total failure here means the probe path is broken.
    const byId = new Map(results.map((r) => [r.id, r.probe]));
    expect(byId.get('winget')?.available).toBe(true);
    expect(byId.get('npm')?.available).toBe(true);
    expect(byId.get('pip')?.available).toBe(true);
    expect(byId.get('rustup')?.available).toBe(true);
  }, 120_000);
});

suite('streaming and cancellation', () => {
  it('streams lines as they arrive rather than only at exit', async () => {
    const winget = await resolveBinary('winget');
    expect(winget).not.toBeNull();

    const stamps: number[] = [];
    const started = Date.now();

    const result = await runCommand({
      file: winget!,
      args: ['upgrade', '--include-unknown', '--disable-interactivity', '--accept-source-agreements'],
      timeoutMs: 180_000,
      onLine: () => stamps.push(Date.now() - started),
    });

    expect(result.lines.length).toBeGreaterThan(5);
    // If output were buffered until close, every timestamp would equal the last one.
    expect(stamps[0]).toBeLessThan(result.durationMs);
  }, 200_000);

  it('kills the process tree on abort and reports it as cancelled', async () => {
    const { rt, abort } = harness();
    const winget = await resolveBinary('winget');

    const promise = runCommand({
      file: winget!,
      args: ['upgrade', '--include-unknown', '--disable-interactivity', '--accept-source-agreements'],
      timeoutMs: 180_000,
      signal: rt.signal,
    });

    setTimeout(() => abort.abort(), 900);
    const result = await promise;

    expect(result.cancelled).toBe(true);
    // Killed, not a clean exit.
    expect(result.code).not.toBe(0);
  }, 60_000);

  it('reports a timeout instead of hanging', async () => {
    const winget = await resolveBinary('winget');
    const result = await runCommand({
      file: winget!,
      args: ['upgrade', '--include-unknown', '--disable-interactivity', '--accept-source-agreements'],
      // Deliberately far too short for a network-bound command.
      timeoutMs: 400,
    });
    expect(result.timedOut).toBe(true);
  }, 60_000);

  it('reports a missing binary as a spawn failure rather than throwing', async () => {
    const result = await runCommand({
      file: 'C:\\Windows\\System32\\definitely-not-a-real-binary.exe',
      args: ['--version'],
      timeoutMs: 10_000,
    });
    expect(result.spawnFailed).toBe(true);
    expect(result.code).toBeNull();
  });
});

suite('a real scan through each available provider', () => {
  it('returns well-formed items with no unsafe ids', async () => {
    for (const provider of providers) {
      const probe = await provider.probe(20_000);
      if (!probe.available || !probe.binary) continue;

      const { rt } = harness(180_000);
      const info = infoFor(provider.id, probe.binary, probe.environments);

      const items = await provider.scan(info, rt);
      for (const item of items) {
        expect(item.key, `${provider.id}: empty key`).toBeTruthy();
        expect(item.id, `${provider.id}: empty id`).toBeTruthy();
        expect(item.id, `${provider.id}: whitespace in id "${item.id}"`).not.toMatch(/\s/);
        expect(item.availableVersion, `${provider.id}: no available version`).toBeTruthy();
        expect(item.provider).toBe(provider.id);
      }
      // Keys must be unique within a provider or the table would collapse rows.
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    }
  }, 600_000);
});

/**
 * The upgrade path, against one real package.
 *
 * Gated behind a SECOND flag because unlike everything above it changes the machine. Set
 * FATE_UPGRADE_TARGET to a pip package name to exercise it:
 *
 *   FATE_INTEGRATION=1 FATE_UPGRADE_TARGET=filelock npx vitest run tests/integration.test.ts
 */
const upgradeTarget = process.env.FATE_UPGRADE_TARGET;
const upgradeSuite = ENABLED && upgradeTarget ? describe : describe.skip;

upgradeSuite('a real pip upgrade', () => {
  it('streams the install and exits zero', async () => {
    const pip = providers.find((p) => p.id === 'pip')!;
    const probe = await pip.probe(20_000);
    expect(probe.available).toBe(true);

    const info = infoFor('pip', probe.binary!, probe.environments);
    // Prefer a user-scope interpreter: a system-wide one writes to a machine-wide site-packages and
    // would fail on permissions in an unelevated test run, which is not what this test is measuring.
    const env =
      probe.environments.find((e) => /user/i.test(e.label)) ?? probe.environments[0]!;
    const { rt, lines } = harness(600_000);

    const result = await pip.upgrade(
      {
        key: `pip:${env.id}:${upgradeTarget}`,
        provider: 'pip',
        environment: env.id,
        id: upgradeTarget!,
        name: upgradeTarget!,
        currentVersion: '0',
        availableVersion: 'latest',
        source: env.label,
        pinned: false,
        uncertain: false,
        local: false,
        location: null,
      },
      info,
      rt,
    );

    expect(result.spawnFailed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    // The command itself must be echoed, then real output must follow.
    expect(lines.some((l) => l.level === 'command')).toBe(true);
    expect(lines.some((l) => /Successfully installed|already satisfied/i.test(l.text))).toBe(true);
  }, 620_000);
});

// ── locations, against the real machine ───────────────────────────────────────────────────────

/**
 * The location resolvers are the one part of this app that CANNOT be proved by fixtures.
 *
 * Everything else parses text; these read the registry, walk manager roots, and ask interpreters
 * about themselves. A resolver that quietly answers null for every row would pass every unit test in
 * the suite and ship a column of dashes, so the assertion that matters is a coverage floor measured
 * against whatever this machine actually has installed.
 */
suite('resolving install locations', () => {
  it('reads the Add/Remove Programs index and resolves entries to real directories', async () => {
    const { readArpIndex } = await import('../src/main/registry.js');
    const index = await readArpIndex(60_000);

    expect(index.size, 'no installed programs found in the registry at all').toBeGreaterThan(10);

    // Every value in the index was confirmed on disk by `locationOf`, so this must hold.
    const { dirExists } = await import('../src/main/paths.js');
    const sample = [...index.exact.values()].slice(0, 12);
    for (const path of sample) {
      expect(await dirExists(path), `${path} was indexed but is not a directory`).toBe(true);
    }
  }, 120_000);

  it('locates most of what pip reports, for every interpreter', async () => {
    const pip = providers.find((p) => p.id === 'pip')!;
    const probe = await pip.probe(30_000);
    if (!probe.available) return;

    const info = infoFor('pip', probe.binary!, probe.environments);
    const { rt } = harness(300_000);
    const items = await pip.scan(info, rt);
    if (items.length === 0) return;

    const located = items.filter((item) => item.location !== null);
    // pip's own metadata is authoritative here, so anything short of near-total coverage is a bug.
    expect(located.length / items.length).toBeGreaterThan(0.9);

    const { dirExists, pathExists } = await import('../src/main/paths.js');
    for (const item of located.slice(0, 10)) {
      const there = (await dirExists(item.location!)) || (await pathExists(item.location!));
      expect(there, `${item.name} reported ${item.location!}, which is not there`).toBe(true);
    }
  }, 600_000);

  it('locates what winget reports, via the registry and the portable package root', async () => {
    const winget = providers.find((p) => p.id === 'winget')!;
    const probe = await winget.probe(30_000);
    if (!probe.available) return;

    const info = infoFor('winget', probe.binary!);
    const { rt } = harness(300_000);
    const items = await winget.scan(info, rt);
    if (items.length === 0) return;

    // Not every ARP entry has a usable location — Store stubs and some MSIs genuinely have none — so
    // this is a floor, not a demand for perfection.
    const located = items.filter((item) => item.location !== null);
    expect(located.length).toBeGreaterThan(0);

    const { dirExists } = await import('../src/main/paths.js');
    for (const item of located) {
      expect(await dirExists(item.location!), `${item.name} → ${item.location!}`).toBe(true);
    }
  }, 600_000);
});
