/**
 * preview.tsx — the design harness entry. Not shipped (see preview.html).
 *
 * Mounts the real `App` with a stubbed bridge and synthetic state so each UI state can be inspected
 * on demand rather than by waiting for it to occur naturally. Every fixture below mirrors the shape of
 * real data captured from this machine.
 */

import '@fontsource-variable/cinzel';
import '@fontsource-variable/inter';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import './src/styles/brand/tokens.css';
import './src/styles/brand/utilities.css';
import './src/styles/app.css';
import './src/styles/fate/tokens.css';
import './src/styles/fate/glass.css';
import './src/styles/fate/controls.css';
import './src/styles/fate/layout.css';

import { createRoot } from 'react-dom/client';
import type { JobState, LogLine, ProviderInfo, UpdateItem } from '../shared/types';
import { App } from './src/App.js';
import {
  appInfoStore,
  elevationStore,
  logStore,
  providersStore,
  runStore,
  scanStore,
  settingsStore,
  toastStore,
  uiStore,
  updateStore,
} from './src/state/index.js';

// ── the stub bridge ───────────────────────────────────────────────────────────────────────────

const noop = async (): Promise<void> => undefined;
const off = (): void => undefined;

Object.defineProperty(window, 'fate', {
  value: {
    getAppInfo: async () => appInfoStore.get(),
    providers: { list: async () => providersStore.get(), refresh: async () => providersStore.get(), onUpdate: () => off },
    scan: { start: noop, cancel: noop, snapshot: async () => scanStore.get(), onUpdate: () => off },
    run: { start: noop, cancel: noop, snapshot: async () => runStore.get(), onUpdate: () => off },
    log: { snapshot: async () => logStore.get(), clear: noop, export: async () => ({ saved: false, path: null, error: null }), onAppend: () => off },
    settings: { get: async () => settingsStore.get(), set: async () => settingsStore.get(), onUpdate: () => off },
    elevation: { state: async () => elevationStore.get(), relaunch: async () => false },
    selfUpdate: {
      state: async () => updateStore.get(),
      check: async () => updateStore.get(),
      download: async () => updateStore.get(),
      install: async () => false,
      cancel: noop,
      onUpdate: () => off,
    },
    window: { minimize: noop, toggleMaximize: noop, close: noop, onState: () => off },
    reveal: async () => true,
    copyText: async () => true,
    openExternal: async () => false,
  },
});

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

const provider = (
  id: ProviderInfo['id'],
  label: string,
  kind: ProviderInfo['kind'],
  version: string | null,
  needsElevation: boolean,
  detail: string | null = null,
  environments: ProviderInfo['environments'] = [],
): ProviderInfo => ({
  id,
  label,
  command: id,
  kind,
  blurb: `${label} packages.`,
  available: detail === null,
  binary: detail === null ? `C:\\bin\\${id}.exe` : null,
  version,
  unavailable: detail === null ? null : 'missing',
  unavailableDetail: detail,
  needsElevation,
  environments,
});

const PROVIDERS: ProviderInfo[] = [
  provider('winget', 'Windows Package Manager', 'system', '1.29.280', true),
  provider('chocolatey', 'Chocolatey', 'system', '2.7.2', true),
  provider('scoop', 'Scoop', 'system', null, false, 'scoop is not on PATH.'),
  provider('npm', 'npm (global)', 'language', '11.17.0', false),
  provider('pnpm', 'pnpm (global)', 'language', null, false, 'pnpm is not on PATH.'),
  provider('pip', 'pip', 'language', '3.14.5', false, null, [
    { id: '3.14', label: 'Python 3.14 · system', path: 'C:\\Python314\\python.exe' },
    { id: '3.13', label: 'Python 3.13 · system', path: 'C:\\Python313\\python.exe' },
  ]),
  provider('cargo', 'cargo', 'language', '1.95.0', false, 'cargo cannot report outdated binaries on its own.'),
  provider('rustup', 'rustup', 'toolchain', '1.29.0', false),
];

const item = (
  key: string,
  name: string,
  id: string,
  from: string,
  to: string,
  prov: UpdateItem['provider'],
  source: string,
  extra: Partial<UpdateItem> = {},
): UpdateItem => ({
  key,
  provider: prov,
  environment: null,
  id,
  name,
  currentVersion: from,
  availableVersion: to,
  source,
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
  ...extra,
});

const ITEMS: UpdateItem[] = [
  item('winget:-:Google.AntigravityIDE', 'Antigravity IDE (User)', 'Google.AntigravityIDE', '2.0.3', '2.1.1', 'winget', 'winget', { location: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Antigravity' }),
  item('winget:-:Docker.DockerDesktop', 'Docker Desktop', 'Docker.DockerDesktop', '4.79.0', '4.84.0', 'winget', 'winget', { location: 'C:\\Program Files\\Docker\\Docker' }),
  item('winget:-:Git.Git', 'Git', 'Git.Git', '2.54.0', '2.55.0.3', 'winget', 'winget', { location: 'C:\\Program Files\\Git' }),
  item('winget:-:GitHub.cli', 'GitHub CLI', 'GitHub.cli', '2.94.0', '2.97.0', 'winget', 'winget', { location: 'C:\\Program Files\\GitHub CLI' }),
  item('winget:-:Ubisoft.Connect', 'Ubisoft Connect', 'Ubisoft.Connect', 'Unknown', '172.1.0.13247', 'winget', 'winget', { uncertain: true, location: 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher' }),
  item('chocolatey:-:ffmpeg', 'ffmpeg', 'ffmpeg', '8.1.1', '8.1.2', 'chocolatey', 'chocolatey', { location: 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg' }),
  item('chocolatey:-:imagemagick', 'imagemagick', 'imagemagick', '7.1.2.2400', '7.1.2.2500', 'chocolatey', 'chocolatey', { pinned: true, location: 'C:\\ProgramData\\chocolatey\\lib\\imagemagick' }),
  item('npm:-:npm', 'npm', 'npm', '11.17.0', '12.0.2', 'npm', 'global', { location: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\npm' }),
  item('pip:3.13:filelock', 'filelock', 'filelock', '3.19.1', '3.32.2', 'pip', 'Python 3.13 · system', { location: 'C:\\Python313\\Lib\\site-packages\\filelock' }),
  item('pip:3.13:numpy', 'numpy', 'numpy', '2.1.0', '2.4.1', 'pip', 'Python 3.13 · system', { location: 'C:\\Python313\\Lib\\site-packages\\numpy' }),
  item('pip:3.10:torch', 'torch', 'torch', '2.0.1+cu118', '2.13.0', 'pip', 'Python 3.10 · user', { local: true, location: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python310\\lib\\site-packages\\torch' }),
  item('pip:3.13:mpmath', 'mpmath', 'mpmath', '1.3.0', '1.4.1', 'pip', 'Python 3.13 · system', { location: 'C:\\Python313\\Lib\\site-packages\\mpmath' }),
  item('pip:3.10:mpmath', 'mpmath', 'mpmath', '1.3.0', '1.4.1', 'pip', 'Python 3.10 · user', { location: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python310\\lib\\site-packages\\mpmath' }),
  item('rustup:-:stable-x86_64-pc-windows-msvc', 'stable-x86_64-pc-windows-msvc', 'stable-x86_64-pc-windows-msvc', '1.95.0', '1.97.1', 'rustup', 'toolchain', { location: 'C:\\Users\\dev\\.rustup\\toolchains\\stable-x86_64-pc-windows-msvc' }),
];

let seq = 0;
const line = (level: LogLine['level'], text: string): LogLine => ({
  seq: seq++,
  // A fixed base time keeps the harness screenshots byte-comparable between runs.
  ts: 1785000000000 + seq * 240,
  level,
  text,
  provider: null,
  jobKey: null,
});

const RUN_LOG: LogLine[] = [
  line('system', 'Updating 4 package(s)'),
  line('warn', 'Not running as administrator — machine-wide packages may fail.'),
  line('system', '[1/4] Git — 2.54.0 → 2.55.0.3'),
  line('command', 'winget.exe upgrade --id Git.Git --exact --silent --accept-package-agreements'),
  line('stdout', 'Found Git [Git.Git] Version 2.55.0.3'),
  line('stdout', 'Downloading https://github.com/git-for-windows/git/releases/download/v2.55.0'),
  line('stdout', 'Successfully verified installer hash'),
  line('stdout', 'Starting package install...'),
  line('success', 'Updated.'),
  line('system', '[2/4] GitHub CLI — 2.94.0 → 2.97.0'),
  line('command', 'winget.exe upgrade --id GitHub.cli --exact --silent'),
  line('stdout', 'Found GitHub CLI [GitHub.cli] Version 2.97.0'),
  line('stdout', 'Starting package install...'),
  line('success', 'Updated.'),
  line('system', '[3/4] filelock — 3.19.1 → 3.32.2'),
  line('command', 'python.exe -m pip install --upgrade filelock'),
  line('stdout', 'Collecting filelock'),
  line('stdout', '  Downloading filelock-3.32.2-py3-none-any.whl (16 kB)'),
  line('stderr', "ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied:"),
  line('stderr', "  'C:\\\\Python313\\\\Lib\\\\site-packages\\\\filelock'"),
  line('error', 'Access denied — this package needs an elevated process. Try "Restart as admin".'),
  line('system', '[4/4] ffmpeg — 8.1.1 → 8.1.2'),
  line('command', 'choco.exe upgrade ffmpeg --yes --no-progress --accept-license'),
  line('stdout', 'Chocolatey v2.7.2'),
  line('stdout', 'Upgrading the following packages:'),
  line('stdout', 'ffmpeg v8.1.2 [Approved]'),
  line('stdout', 'ffmpeg package files upgrade completed.'),
];

const job = (
  key: string,
  name: string,
  prov: JobState['provider'],
  target: string,
  status: JobState['status'],
  detail: string | null = null,
): JobState => ({
  key,
  provider: prov,
  name,
  targetVersion: target,
  status,
  exitCode: status === 'success' ? 0 : status === 'failed' ? 1 : null,
  startedAt: 1785000000000,
  finishedAt: status === 'running' || status === 'queued' ? null : 1785000004000,
  detail,
  retryable: status === 'failed',
});

// ── states ────────────────────────────────────────────────────────────────────────────────────

appInfoStore.set({
  productName: "Don't Leave Updates To Fate",
  version: '1.2.1',
  electron: '43.2.0',
  chrome: '140',
  node: '22',
  publisher: 'VagueDustin Enterprises',
  footer: 'Provided by VagueDustin Enterprises™ · © 2026 Don\'t Leave Updates To Fate. All rights reserved.',
  portable: false,
  isPackaged: true,
});

providersStore.set(PROVIDERS);
elevationStore.set({ isElevated: false, recommended: true });

const state = new URLSearchParams(window.location.search).get('state') ?? 'running';

scanStore.set({
  phase: 'done',
  startedAt: 1785000000000,
  finishedAt: 1785000024400,
  inFlight: [],
  results: PROVIDERS.filter((p) => p.available).map((p) => ({
    provider: p.id,
    status: 'ok' as const,
    items: ITEMS.filter((i) => i.provider === p.id),
    durationMs: 1200,
    error: null,
  })),
  items: ITEMS,
});

if (state === 'running') {
  logStore.set(RUN_LOG.slice(0, 17));
  runStore.set({
    id: 'preview',
    phase: 'running',
    startedAt: 1785000000000,
    finishedAt: null,
    activeKey: 'pip:3.13:filelock',
    brokenShortcuts: [],
    jobs: [
      job('winget:-:Git.Git', 'Git', 'winget', '2.55.0.3', 'success'),
      job('winget:-:GitHub.cli', 'GitHub CLI', 'winget', '2.97.0', 'success'),
      job('pip:3.13:filelock', 'filelock', 'pip', '3.32.2', 'running'),
      job('chocolatey:-:ffmpeg', 'ffmpeg', 'chocolatey', '8.1.2', 'queued'),
    ],
  });
  uiStore.set((prev) => ({
    ...prev,
    selected: new Set(['winget:-:Git.Git', 'winget:-:GitHub.cli', 'pip:3.13:filelock', 'chocolatey:-:ffmpeg']),
  }));
} else if (state === 'finished') {
  logStore.set(RUN_LOG);
  runStore.set({
    id: 'preview',
    phase: 'done',
    startedAt: 1785000000000,
    finishedAt: 1785000030000,
    activeKey: null,
    brokenShortcuts: [
      {
        shortcut: 'C:\\Users\\Public\\Desktop\\Epic Games Launcher.lnk',
        name: 'Epic Games Launcher',
        target:
          'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
      },
    ],
    jobs: [
      job('winget:-:Git.Git', 'Git', 'winget', '2.55.0.3', 'success'),
      job('winget:-:GitHub.cli', 'GitHub CLI', 'winget', '2.97.0', 'success'),
      job('pip:3.13:filelock', 'filelock', 'pip', '3.32.2', 'failed', 'Access denied — this package needs an elevated process.'),
      job('chocolatey:-:ffmpeg', 'ffmpeg', 'chocolatey', '8.1.2', 'success'),
    ],
  });
  toastStore.set([
    { id: 1, kind: 'success', text: 'Log exported to DontLeaveUpdatesToFate-log-20260801-150312.txt', action: { label: 'Show in folder', run: () => undefined } },
  ]);
} else if (state === 'settings') {
  logStore.set(RUN_LOG.slice(0, 8));
  uiStore.set((prev) => ({ ...prev, showSettings: true }));
  // A realistic "you are up to date" reading, rather than the unpackaged default.
  updateStore.set((prev) => ({
    ...prev,
    stage: 'current',
    current: '1.2.1',
    channel: 'installed',
    checkedAt: 1785000000000,
  }));
} else if (state === 'update') {
  logStore.set(RUN_LOG.slice(0, 6));
  updateStore.set({
    stage: 'available',
    current: '1.2.0',
    channel: 'installed',
    release: {
      version: '1.2.1',
      name: '1.2.1 — Make the handover actually happen',
      notesUrl: 'https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/tag/v1.2.1',
      publishedAt: '2026-08-23T06:00:00Z',
      assetName: 'DontLeaveUpdatesToFate-1.2.1-setup.exe',
      assetSize: 103_000_000,
    },
    received: 0,
    total: 0,
    downloaded: null,
    verified: false,
    checkedAt: 1785000000000,
    error: null,
  });
} else if (state === 'empty') {
  scanStore.set({ phase: 'done', startedAt: 1785000000000, finishedAt: 1785000012000, inFlight: [], results: [], items: [] });
  logStore.set([line('system', 'Scanning 5 package manager(s)'), line('success', 'Scan complete in 12.0s — 0 update(s) waiting.')]);
}

settingsStore.set({
  disabledProviders: [],
  skipped: [
    { key: 'winget:EpicGames.EpicGamesLauncher', version: null, name: 'Epic Games Launcher', at: 0 },
    { key: 'winget:OBSProject.OBSStudio', version: '32.2.1', name: 'OBS Studio', at: 0 },
  ],
  includeUncertain: true,
  scanOnLaunch: true,
  scanTimeoutSec: 180,
  updateTimeoutSec: 900,
  followTerminal: true,
  respectReducedMotion: true,
  glassEffects: true,
  verifyShortcuts: true,
  checkForUpdates: true,
});

// Exposed for the screenshot harness only, so a stage that the stub bridge cannot reach can still be
// posed and captured. Never present in the shipped renderer — preview.tsx is not in the build.
(window as unknown as Record<string, unknown>).__fateStores = { updateStore, scanStore, runStore };

createRoot(document.getElementById('root')!).render(<App />);
