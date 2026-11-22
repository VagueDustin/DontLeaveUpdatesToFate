/**
 * workbench.test.tsx: the model behind the Workbench layout, and the layout's own contract.
 *
 * The model is pure, so most of this needs no renderer. The last two blocks render the real App
 * against the stores (no browser) and read the stylesheets, because "exactly one gold button" and
 * "the glass filter is never on a scroller" are rules that a refactor breaks silently.
 */

import './renderer-env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobState, ProviderInfo, UpdateItem } from '../src/shared/types.js';
import { fileManagerName } from '../src/shared/keys.js';
import { App } from '../src/renderer/src/App.js';
import { dockText } from '../src/renderer/src/components/RunDock.js';
import { sourcesOf } from '../src/renderer/src/components/Sources.js';
import { readStatus } from '../src/renderer/src/components/WindowBar.js';
import { providersStore, runStore, scanStore, settingsStore, uiStore } from '../src/renderer/src/state/app.js';
import {
  buildRows,
  bumpOf,
  canOverride,
  checksFor,
  filterRows,
  groupRows,
  heldReason,
  needsAdmin,
  queueOf,
  trackOf,
} from '../src/renderer/src/state/workbench.js';

const provider = (id: ProviderInfo['id'], kind: ProviderInfo['kind'], extra: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  label: id,
  command: id,
  kind,
  blurb: '',
  needsElevation: id === 'winget' || id === 'chocolatey',
  available: true,
  binary: `C:\\bin\\${id}.exe`,
  version: '1.0.0',
  unavailable: null,
  unavailableDetail: null,
  environments: [],
  ...extra,
});

const PROVIDERS: ProviderInfo[] = [
  provider('winget', 'system'),
  provider('chocolatey', 'system'),
  provider('scoop', 'system', { available: false, binary: null, unavailable: 'missing', unavailableDetail: 'scoop is not on PATH.' }),
  provider('npm', 'language'),
  provider('pip', 'language', {
    environments: [
      { id: '3.13', label: 'Python 3.13 · system', path: 'C:\\Python313\\python.exe' },
      { id: '3.10', label: 'Python 3.10 · user', path: 'C:\\Users\\dev\\Python310\\python.exe' },
    ],
  }),
];

const item = (provider_: UpdateItem['provider'], id: string, from: string, to: string, extra: Partial<UpdateItem> = {}): UpdateItem => ({
  key: `${provider_}:${extra.environment ?? '-'}:${id}`,
  provider: provider_,
  environment: null,
  id,
  name: id,
  currentVersion: from,
  availableVersion: to,
  source: provider_,
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
  ...extra,
});

const job = (key: string, status: JobState['status'], extra: Partial<JobState> = {}): JobState => ({
  key,
  provider: 'winget',
  name: key,
  targetVersion: '2',
  status,
  exitCode: null,
  startedAt: 1,
  finishedAt: null,
  detail: null,
  retryable: false,
  ...extra,
});

const ITEMS = [
  item('winget', 'Git.Git', '2.55.0', '2.56.1'),
  item('winget', 'Microsoft.WSL', '2.7.13.0', '3.0.5'),
  item('winget', 'OBS', '32.2.2', '33.0.1'),
  item('chocolatey', 'ffmpeg', '9.0.2', '9.1.0'),
  item('pip', 'numpy', '2.5.4', '2.5.5', { environment: '3.13', source: 'Python 3.13 · system' }),
  item('pip', 'tomlkit', '0.14.0', '0.15.2', {
    environment: '3.10',
    source: 'Python 3.10 · user · gradio needs tomlkit<0.15.0,>=0.12.0',
    pinned: true,
  }),
  item('pip', 'torch', '2.0.1+cu118', '2.13.0', { environment: '3.10', source: 'Python 3.10 · user', local: true }),
  item('winget', 'Python.Python.3.13', '3.13.16', '3.13.17', {
    source: 'Updated through Chocolatey (python313)',
    pinned: true,
    ownerKey: 'chocolatey:-:python313',
  }),
  item('chocolatey', 'imagemagick', '7.1.2.24', '7.1.2.25', { pinned: true, source: null }),
];

describe('bumpOf', () => {
  it('names the first of the leading three numbers that moves', () => {
    expect(bumpOf('2.7.13.0', '3.0.5')).toBe('major');
    expect(bumpOf('2.55.0', '2.56.1')).toBe('minor');
    expect(bumpOf('2.5.4', '2.5.5')).toBe('patch');
    // A fourth segment is still a patch-sized move.
    expect(bumpOf('16.11.60.1', '16.11.60.2')).toBe('patch');
  });

  it('makes no claim when a side has no numbers at all', () => {
    expect(bumpOf('Unknown', '1.1')).toBeNull();
  });
});

describe('where a row stands', () => {
  const rows = buildRows(
    ITEMS,
    [
      job('winget:-:Git.Git', 'success', { finishedAt: 2 }),
      job('winget:-:OBS', 'failed', { detail: 'In use by a running application. (0x8A150111)', retryable: true }),
      job('chocolatey:-:ffmpeg', 'running'),
      job('pip:3.13:numpy', 'queued'),
      job('winget:-:Microsoft.WSL', 'cancelled'),
    ],
    PROVIDERS,
  );
  const state = (id: string): string => rows.find((row) => row.item.id === id)!.state;

  it('follows the run for anything in it', () => {
    expect(state('Git.Git')).toBe('done');
    expect(state('OBS')).toBe('failed');
    expect(state('ffmpeg')).toBe('running');
    expect(state('numpy')).toBe('queued');
  });

  it('puts a cancelled package back in the list as ready, since it never ran', () => {
    expect(state('Microsoft.WSL')).toBe('ready');
  });

  it('treats a package the manager declined as needing a person, with the manager reason', () => {
    const [row] = buildRows([ITEMS[0]!], [job('winget:-:Git.Git', 'skipped', { detail: 'Pinned in winget.' })], PROVIDERS);
    expect(row).toMatchObject({ state: 'failed', note: 'Pinned in winget.' });
  });

  it('holds pinned and local rows, and says why in a sentence', () => {
    expect(state('tomlkit')).toBe('held');
    expect(state('torch')).toBe('held');
    expect(heldReason(ITEMS[5]!)).toBe('Held back: gradio needs tomlkit<0.15.0,>=0.12.0.');
    expect(heldReason(ITEMS[6]!)).toMatch(/A local build \(2\.0\.1\+cu118\)/);
    expect(heldReason(ITEMS[7]!)).toBe('Updated through Chocolatey (python313), which installed it and has the same update.');
    expect(heldReason(ITEMS[8]!)).toBe('Pinned in its package manager.');
    expect(heldReason(ITEMS[0]!)).toBeNull();
  });

  it('files each row under its manager, and each Python under its own name', () => {
    const source = (id: string): string => rows.find((row) => row.item.id === id)!.source;
    expect(source('Git.Git')).toBe('winget');
    expect(source('numpy')).toBe('Python 3.13 · system');
    // The held reason is appended to the item source; the sidebar name must not carry it.
    expect(source('tomlkit')).toBe('Python 3.10 · user');
    expect(rows.find((row) => row.item.id === 'numpy')!.kind).toBe('Python');
    expect(rows.find((row) => row.item.id === 'ffmpeg')!.kind).toBe('Apps');
  });
});

describe('overriding a hold', () => {
  it('is offered for a local build and for a program another manager also updates', () => {
    expect(canOverride(ITEMS[6]!)).toBe(true);
    expect(canOverride(ITEMS[7]!)).toBe(true);
  });

  it('is not offered where the manager would refuse, or where it would break another package', () => {
    expect(canOverride(ITEMS[8]!)).toBe(false);
    expect(canOverride(ITEMS[5]!)).toBe(false);
  });

  it('is not offered for a local build that a dependency also holds', () => {
    // A CUDA build of torch whose installed torchvision requires this torch: both reasons apply, and
    // the dependency one must win.
    const both = { ...ITEMS[6]!, pinned: true, source: 'Python 3.10 · user · torchvision needs torch==2.0.1' };
    expect(canOverride(both)).toBe(false);
  });
});

describe('the ledger order', () => {
  const rows = buildRows(
    ITEMS,
    [
      job('winget:-:Git.Git', 'success'),
      job('winget:-:OBS', 'failed'),
      job('pip:3.13:numpy', 'queued'),
      job('chocolatey:-:ffmpeg', 'running'),
    ],
    PROVIDERS,
  );

  it('pins what needs a person first and sinks held and updated to the bottom', () => {
    expect(groupRows(rows).map((group) => group.name)).toEqual([
      'Needs you',
      'In this run',
      'Apps · winget',
      'Held back',
      'Updated',
    ]);
  });

  it('leads the run group with the package being updated', () => {
    const run = groupRows(rows).find((group) => group.name === 'In this run')!;
    expect(run.rows.map((row) => row.item.id)).toEqual(['ffmpeg', 'numpy']);
  });

  it('narrows by search, status, source and major jumps', () => {
    const ids = (filter: Partial<Parameters<typeof filterRows>[1]>): string[] =>
      filterRows(rows, { query: '', status: null, source: null, majorsOnly: false, ...filter }).map((row) => row.item.id);
    expect(ids({ query: 'wsl' })).toEqual(['Microsoft.WSL']);
    expect(ids({ status: 'failed' })).toEqual(['OBS']);
    expect(ids({ source: 'Python 3.10 · user' })).toEqual(['tomlkit', 'torch']);
    expect(ids({ majorsOnly: true })).toEqual(['Microsoft.WSL', 'OBS']);
    // The source name is searchable, so "python 3.13" finds that interpreter's packages.
    expect(ids({ query: 'python 3.13' })).toContain('numpy');
  });
});

describe('the queue and the track', () => {
  const idle = buildRows(ITEMS, [], PROVIDERS);

  it('queues every ready row that has not been unticked, and never a held one', () => {
    expect(queueOf(idle, new Set()).map((row) => row.item.id)).toEqual(['Git.Git', 'Microsoft.WSL', 'OBS', 'ffmpeg', 'numpy']);
    expect(queueOf(idle, new Set(['winget:-:OBS'])).map((row) => row.item.id)).not.toContain('OBS');
  });

  it('draws the plan before a run and the run, in run order, once there is one', () => {
    const queue = queueOf(idle, new Set());
    expect(trackOf(idle, [], queue)).toEqual(queue);

    const jobs = [job('chocolatey:-:ffmpeg', 'success'), job('winget:-:Git.Git', 'running'), job('winget:-:OBS', 'cancelled')];
    const during = buildRows(ITEMS, jobs, PROVIDERS);
    expect(trackOf(during, jobs, queueOf(during, new Set())).map((row) => row.item.id)).toEqual(['ffmpeg', 'Git.Git']);
  });
});

describe('before you update', () => {
  const rows = buildRows(ITEMS, [], PROVIDERS);
  const row = (id: string) => rows.find((r) => r.item.id === id)!;

  it('warns about a major jump, a missing administrator and an app that may be open', () => {
    const wsl = row('Microsoft.WSL');
    const tones = checksFor(wsl, needsAdmin(wsl, PROVIDERS, false)).map((check) => check.text);
    expect(tones.some((text) => /major version/.test(text))).toBe(true);
    expect(tones.some((text) => /administrator/.test(text))).toBe(true);
    expect(tones.some((text) => /program is open/.test(text))).toBe(true);
  });

  it('drops the administrator warning once the app is elevated', () => {
    const wsl = row('Microsoft.WSL');
    expect(needsAdmin(wsl, PROVIDERS, true)).toBe(false);
  });

  it('says so when there is nothing unusual', () => {
    const numpy = row('numpy');
    expect(checksFor(numpy, false)).toEqual([{ tone: 'ok', text: 'Nothing unusual about this update.' }]);
  });

  it('leads with the reason for a held row', () => {
    expect(checksFor(row('tomlkit'), false)[0]).toEqual({ tone: 'stop', text: 'Held back: gradio needs tomlkit<0.15.0,>=0.12.0.' });
  });
});

describe('the words in the dock and the window bar', () => {
  const base = {
    scanned: true,
    inFlight: 0,
    queued: 0,
    rows: 0,
    total: 0,
    done: 0,
    failed: 0,
    remaining: 0,
    activeName: null,
    activeVersion: null,
    majors: 0,
    admin: 0,
  };

  it('describes the plan, with what to look out for', () => {
    expect(dockText({ ...base, phase: 'idle', queued: 20, rows: 27, majors: 4, admin: 10 })).toEqual({
      title: '20 in the queue',
      detail: 'One at a time, in this order. 4 major jumps. 10 need an administrator.',
    });
  });

  it('tells apart never scanned, nothing found and nothing ticked', () => {
    expect(dockText({ ...base, phase: 'idle', scanned: false }).title).toBe('Nothing scanned yet');
    expect(dockText({ ...base, phase: 'idle' }).title).toBe('Everything is current');
    expect(dockText({ ...base, phase: 'idle', rows: 5 }).title).toBe('Nothing in the queue');
  });

  it('counts the package in progress while running, and never past the total', () => {
    expect(dockText({ ...base, phase: 'running', total: 4, done: 2, remaining: 1, activeName: 'filelock', activeVersion: '3.32.2' })).toEqual({
      title: 'Updating 3 of 4',
      detail: 'filelock to 3.32.2 · 1 after it',
    });
    expect(dockText({ ...base, phase: 'running', total: 4, done: 4 }).title).toBe('Updating 4 of 4');
  });

  it('reports the run, and only mentions an administrator when a failure was about one', () => {
    expect(dockText({ ...base, phase: 'done', total: 20, done: 16, failed: 4, admin: 3 })).toEqual({
      title: '16 updated, 4 need you',
      detail: 'Each one says what to do. 3 failures need an administrator.',
    });
    expect(dockText({ ...base, phase: 'done', total: 3, done: 3 }).detail).toBe('Everything in the run went through.');
  });

  it('gives the window bar one line for each thing the app can be doing', () => {
    const status = { scanPhase: 'done', inFlight: 0, ready: 0, runPhase: 'idle', activeName: null, done: 0, total: 0, failed: 0 };
    expect(readStatus({ ...status, runPhase: 'running', activeName: 'Git', done: 1, total: 4 }).text).toBe('Updating 2 of 4 · Git');
    expect(readStatus({ ...status, scanPhase: 'scanning', inFlight: 1 }).text).toBe('Scanning · 1 manager left');
    expect(readStatus({ ...status, failed: 2, ready: 5 }).text).toBe('2 updates need you');
    expect(readStatus({ ...status, ready: 1 }).text).toBe('1 update ready');
    expect(readStatus(status)).toEqual({ state: 'ready', text: 'Everything is current' });
  });
});

describe('the sources list', () => {
  it('lists each usable manager once, and each Python on its own', () => {
    expect(sourcesOf(PROVIDERS).map((source) => source.name)).toEqual([
      'winget',
      'Chocolatey',
      'npm',
      'Python 3.13 · system',
      'Python 3.10 · user',
    ]);
  });
});

describe('fileManagerName', () => {
  it('says Finder on a Mac and Explorer on Windows', () => {
    expect(fileManagerName('mac')).toBe('Finder');
    expect(fileManagerName('windows')).toBe('Explorer');
  });
});

// ── the rendered layout ───────────────────────────────────────────────────────────────────────

function buttons(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
}

describe('the window, rendered', () => {
  beforeEach(() => {
    providersStore.set(PROVIDERS);
    settingsStore.set((prev) => ({ ...prev, includeUncertain: true, disabledProviders: [] }));
    scanStore.set({ phase: 'done', startedAt: 1, finishedAt: 2, inFlight: [], results: [], items: ITEMS });
    runStore.set({ id: '', phase: 'idle', startedAt: null, finishedAt: null, jobs: [], activeKey: null, brokenShortcuts: [] });
    uiStore.set((prev) => ({ ...prev, query: '', statusFilter: null, sourceFilter: null, majorsOnly: false, excluded: new Set() }));
  });

  it('has exactly one gold primary, and it is the Update button', () => {
    const html = renderToStaticMarkup(<App />);
    const primary = buttons(html).filter((b) => /\bbtn--primary\b/.test(b));
    expect(primary).toHaveLength(1);
    expect(html).toMatch(/btn--primary dock__go[^>]*>Update 5</);
  });

  it('styles every button with classes, never inline colour', () => {
    for (const b of buttons(renderToStaticMarkup(<App />))) {
      // The composition bar and the meters size their segments inline; nothing sets a colour that way.
      expect(b).not.toMatch(/style="[^"]*(?:color|background)/);
    }
  });

  it('keeps held rows out of the count on the Update button and folds them away', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Held back');
    // Folded by default: the group heading is there, its rows are not.
    expect(html).not.toContain('id="row-pip:3.10:tomlkit"');
    expect(html).toContain('id="row-winget:-:Git.Git"');
  });

  it('offers Retry only once something retryable has failed', () => {
    expect(renderToStaticMarkup(<App />)).not.toMatch(/Retry \d+ failed/);
    runStore.set((prev) => ({
      ...prev,
      phase: 'done',
      finishedAt: 3,
      jobs: [job('winget:-:OBS', 'failed', { retryable: true, detail: 'In use.' }), job('winget:-:Git.Git', 'success')],
    }));
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Retry 1 failed');
    expect(html).toContain('1 updated, 1 need you');
  });

  it('does not bring back a cancelled package that has since left the scan', () => {
    // Rendered once with everything, so the window has seen Git.
    renderToStaticMarkup(<App />);
    // Then a run is cancelled before Git starts, and Git is skipped: the scan no longer lists it.
    scanStore.set((prev) => ({ ...prev, items: ITEMS.filter((i) => i.id !== 'Git.Git') }));
    runStore.set((prev) => ({ ...prev, phase: 'cancelled', finishedAt: 3, jobs: [job('winget:-:Git.Git', 'cancelled')] }));
    const html = renderToStaticMarkup(<App />);
    expect(html).not.toContain('id="row-winget:-:Git.Git"');
    expect(html).toMatch(/dock__go[^>]*>Update 4</);
  });

  it('still shows a package that left the scan because it was updated', () => {
    renderToStaticMarkup(<App />);
    scanStore.set((prev) => ({ ...prev, items: ITEMS.filter((i) => i.id !== 'Git.Git') }));
    runStore.set((prev) => ({ ...prev, phase: 'done', finishedAt: 3, jobs: [job('winget:-:Git.Git', 'success')] }));
    uiStore.set((prev) => ({ ...prev, folded: new Set() }));
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('id="row-winget:-:Git.Git"');
    expect(html).toContain('1 updated');
  });

  it('swaps the actions for a single Cancel while a run is going', () => {
    runStore.set((prev) => ({ ...prev, phase: 'running', activeKey: 'winget:-:Git.Git', jobs: [job('winget:-:Git.Git', 'running')] }));
    const html = renderToStaticMarkup(<App />);
    expect(html).toMatch(/btn--danger[^>]*>.*Cancel/s);
    expect(html).not.toContain('dock__go');
  });
});

// ── the stylesheet contract ───────────────────────────────────────────────────────────────────

describe('the surface', () => {
  const read = (file: string): string => readFileSync(join(import.meta.dirname, '..', 'src/renderer/src/styles', file), 'utf8');
  const workbench = read('workbench.css');
  const controls = read('fate/controls.css');
  const rule = (css: string, selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('caps the width of the list, so a name and its versions are never a screen apart', () => {
    expect(rule(workbench, '.work')).toMatch(/grid-template-columns:[^;]*minmax\(0, 920px\)/);
    expect(rule(workbench, '.work')).toContain('justify-content: center');
    // `.dock` also shares a rule with `.pane`; this is its own.
    expect(workbench).toMatch(/\n\.dock \{\s*flex: none;[^}]*width: min\([^;]*1080px\)/);
  });

  it('never puts the glass filter on a scroller, and gives the Ledger no filter at all', () => {
    expect(rule(workbench, '.pane__scroll')).not.toContain('backdrop-filter');
    expect(rule(workbench, '.pane::before,\n.dock::before')).toContain('backdrop-filter');
    expect(rule(workbench, '.ledger::before')).toContain('backdrop-filter: none');
  });

  it('turns every filter off when glass is switched off', () => {
    expect(workbench).toMatch(/:root\[data-glass='off'\] \.pane::before,\s*:root\[data-glass='off'\] \.dock::before \{\s*backdrop-filter: none/);
    expect(workbench).toMatch(/:root\[data-glass='off'\] \.bar \{\s*backdrop-filter: none/);
  });

  it('makes the primary flat gold with dark text, in the interface face', () => {
    const primary = rule(controls, '.btn--primary');
    expect(primary).toContain('background: var(--accent-default)');
    expect(primary).toContain('color: var(--text-inverse)');
    expect(primary).not.toContain('gradient');
    expect(rule(controls, '.btn')).toContain('font-family: var(--font-sans)');
    expect(controls).not.toContain('--btn-sheen');
  });

  it('disables with a surface and text colour, not opacity', () => {
    const disabled = rule(controls, '.btn:disabled');
    expect(disabled).toContain('var(--text-faint)');
    expect(disabled).not.toContain('opacity');
  });

  it('uses a 2px emphasis focus ring', () => {
    expect(rule(controls, '.btn:focus-visible')).toMatch(/outline:\s*2px solid var\(--border-emphasis\)/);
  });
});
