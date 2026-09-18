/**
 * app.ts — the renderer's stores and the one place that talks to the preload bridge.
 *
 * Components read stores and call the action functions here; none of them touch `window.fate`
 * directly. That keeps the IPC surface in one file and makes the data flow one-directional:
 * action → main process → push event → store → render.
 */

import type {
  AppInfo,
  AppSettings,
  ElevationState,
  LogExportFormat,
  LogLine,
  ProviderId,
  ProviderInfo,
  RunSnapshot,
  ScanSnapshot,
  SkipRule,
  UpdateItem,
  UpdateState,
} from '@shared/types';
import { isSkipped, skipKeyFor } from '@shared/types';
import { Store } from './store.js';

/** Lines held for display. The main process keeps 50k for export; the pane only needs scrollback. */
const RENDERER_LOG_CAP = 20_000;

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /** Set when the toast offers an action, e.g. "Show in folder" after an export. */
  action?: { label: string; run: () => void };
}

export interface UiState {
  query: string;
  /** null = all managers. */
  providerFilter: ProviderId | null;
  selected: ReadonlySet<string>;
  showSettings: boolean;
  /** Fraction of the main area given to the package table. */
  splitRatio: number;
  /** True when the terminal is scrolled away from the newest line. */
  terminalDetached: boolean;
}

export const appInfoStore = new Store<AppInfo | null>(null);
export const providersStore = new Store<ProviderInfo[]>([]);
export const scanStore = new Store<ScanSnapshot>({
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  inFlight: [],
  results: [],
  items: [],
});
export const runStore = new Store<RunSnapshot>({
  id: '',
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  jobs: [],
  activeKey: null,
  brokenShortcuts: [],
});
export const settingsStore = new Store<AppSettings>({
  disabledProviders: [],
  skipped: [],
  includeUncertain: false,
  scanOnLaunch: true,
  scanTimeoutSec: 180,
  updateTimeoutSec: 900,
  followTerminal: true,
  respectReducedMotion: true,
  glassEffects: true,
  verifyShortcuts: true,
  checkForUpdates: true,
});
export const elevationStore = new Store<ElevationState>({ isElevated: false, recommended: false });
export const updateStore = new Store<UpdateState>({
  stage: 'idle',
  current: '0.0.0',
  channel: 'dev',
  release: null,
  received: 0,
  total: 0,
  downloaded: null,
  verified: false,
  checkedAt: null,
  error: null,
});
export const logStore = new Store<readonly LogLine[]>([]);
export const toastStore = new Store<readonly Toast[]>([]);
export const uiStore = new Store<UiState>({
  query: '',
  providerFilter: null,
  selected: new Set(),
  showSettings: false,
  splitRatio: 0.56,
  terminalDetached: false,
});

// ── toasts ────────────────────────────────────────────────────────────────────────────────────

let toastSeq = 0;

/** Most toasts on screen at once. Beyond this the oldest goes, rather than covering the window. */
const MAX_TOASTS = 4;

export function toast(kind: ToastKind, text: string, action?: Toast['action']): void {
  const id = ++toastSeq;
  const entry: Toast = action ? { id, kind, text, action } : { id, kind, text };
  toastStore.set((prev) => [...prev, entry].slice(-MAX_TOASTS));
  // Errors linger: they usually need reading. Confirmations get out of the way.
  const ttl = kind === 'error' ? 9000 : 4500;
  setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
  toastStore.set((prev) => (prev.some((t) => t.id === id) ? prev.filter((t) => t.id !== id) : prev));
}

// ── motion preference ─────────────────────────────────────────────────────────────────────────

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Reflect the effective motion preference onto <html data-motion>.
 *
 * Every decorative animation is disabled through that one attribute rather than a media query
 * repeated per rule, and `respectReducedMotion: false` lets a user who has the OS switch on for
 * other reasons still see this app's animations.
 */
function applyMotion(): void {
  const respect = settingsStore.get().respectReducedMotion;
  const reduce = respect && motionQuery.matches;
  document.documentElement.dataset.motion = reduce ? 'off' : 'on';
}

motionQuery.addEventListener('change', applyMotion);
settingsStore.subscribe(applyMotion);

// ── glass preference ──────────────────────────────────────────────────────────────────────────

const transparencyQuery = window.matchMedia('(prefers-reduced-transparency: reduce)');

/**
 * Reflect the effective glass preference onto <html data-glass>, exactly as applyMotion does.
 *
 * Either lever turns it off: the setting, or the OS asking for reduced transparency. The setting is
 * the one that can be trusted — Chromium's documented mapping for prefers-reduced-transparency is
 * macOS, and whether it reaches Windows Settings is unverified — so the media query is treated as a
 * bonus rather than the mechanism.
 */
function applyGlass(): void {
  const wanted = settingsStore.get().glassEffects;
  const off = !wanted || transparencyQuery.matches;
  document.documentElement.dataset.glass = off ? 'off' : 'on';
}

transparencyQuery.addEventListener('change', applyGlass);
settingsStore.subscribe(applyGlass);

// ── selection helpers ─────────────────────────────────────────────────────────────────────────

export function setQuery(query: string): void {
  uiStore.set((prev) => ({ ...prev, query }));
}

export function setProviderFilter(providerFilter: ProviderId | null): void {
  uiStore.set((prev) => ({
    ...prev,
    providerFilter: prev.providerFilter === providerFilter ? null : providerFilter,
  }));
}

export function toggleSelected(key: string): void {
  uiStore.set((prev) => {
    const next = new Set(prev.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { ...prev, selected: next };
  });
}

export function setSelection(keys: Iterable<string>): void {
  uiStore.set((prev) => ({ ...prev, selected: new Set(keys) }));
}

export function clearSelection(): void {
  uiStore.set((prev) => (prev.selected.size === 0 ? prev : { ...prev, selected: new Set() }));
}

export function setShowSettings(showSettings: boolean): void {
  uiStore.set((prev) => ({ ...prev, showSettings }));
}

export function setSplitRatio(splitRatio: number): void {
  uiStore.set((prev) => ({ ...prev, splitRatio: Math.min(0.86, Math.max(0.16, splitRatio)) }));
}

export function setTerminalDetached(terminalDetached: boolean): void {
  uiStore.set((prev) =>
    prev.terminalDetached === terminalDetached ? prev : { ...prev, terminalDetached },
  );
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────

export async function startScan(): Promise<void> {
  clearSelection();
  await window.fate.scan.start();
}

export async function cancelScan(): Promise<void> {
  await window.fate.scan.cancel();
}

/**
 * `continueRun` keeps the finished run on screen and folds these results into it.
 *
 * Used by "Retry failed": the seventy-three rows that already say "Updated" are the record of what
 * just happened, and starting a fresh run to retry one of them threw that record away.
 */
export async function startRun(keys: string[], continueRun = false): Promise<void> {
  if (keys.length === 0) return;
  await window.fate.run.start(keys, continueRun);
}

export async function cancelRun(): Promise<void> {
  await window.fate.run.cancel();
}

export async function refreshProviders(): Promise<void> {
  await window.fate.providers.refresh();
  elevationStore.set(await window.fate.elevation.state());
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  settingsStore.set(await window.fate.settings.set(patch));
}

/**
 * Skip a package — for this version only, or for good.
 *
 * A "forever" rule replaces any version-specific rule for the same package, so choosing "never" after
 * "skip this version" does not leave a redundant entry behind in Settings.
 */
export async function skipPackage(item: UpdateItem, scope: 'version' | 'forever'): Promise<void> {
  const key = skipKeyFor(item);
  const version = scope === 'forever' ? null : item.availableVersion;
  const existing = settingsStore.get().skipped;

  const kept =
    scope === 'forever'
      ? existing.filter((rule) => rule.key !== key)
      : existing.filter((rule) => !(rule.key === key && rule.version === version));

  const rule: SkipRule = { key, version, name: item.name, at: Date.now() };
  await patchSettings({ skipped: [...kept, rule] });

  toast(
    'info',
    scope === 'forever'
      ? `${item.name} will not be offered again.`
      : `${item.name} ${item.availableVersion} skipped. It will reappear when a newer version is released.`,
  );
  // Drop it from the current view straight away rather than waiting for a rescan.
  scanStore.set((prev) => ({
    ...prev,
    items: prev.items.filter((candidate) => !isSkipped(candidate, [rule])),
  }));
}

/** Remove a skip rule, so the package is offered again. */
export async function unskip(rule: SkipRule): Promise<void> {
  const remaining = settingsStore
    .get()
    .skipped.filter((candidate) => !(candidate.key === rule.key && candidate.version === rule.version));
  await patchSettings({ skipped: remaining });
}

export async function toggleProviderEnabled(id: ProviderId): Promise<void> {
  const current = settingsStore.get().disabledProviders;
  const disabled = current.includes(id)
    ? current.filter((p) => p !== id)
    : [...current, id];
  await patchSettings({ disabledProviders: disabled });
}

export async function clearLog(): Promise<void> {
  await window.fate.log.clear();
  logStore.set([]);
}

export async function exportLog(format: LogExportFormat): Promise<void> {
  const outcome = await window.fate.log.export(format);
  if (outcome.error) {
    toast('error', `Could not write the log: ${outcome.error}`);
    return;
  }
  if (!outcome.saved || !outcome.path) return;

  const path = outcome.path;
  toast('success', `Log exported to ${basename(path)}`, {
    label: 'Show in folder',
    run: () => void window.fate.reveal(path),
  });
}

/** Open Explorer at a package's install location, telling the user when it is not there. */
export async function revealLocation(path: string, name: string): Promise<void> {
  const shown = await window.fate.reveal(path);
  if (!shown) toast('error', `${name} is not at ${path} any more.`);
}

/** Put a path on the clipboard, via the main process — see `copyText` in the preload. */
export async function copyPath(path: string): Promise<void> {
  if (await window.fate.copyText(path)) toast('success', 'Path copied.');
  else toast('error', 'The clipboard refused the copy.');
}

// ── self-update ───────────────────────────────────────────────────────────────────────────────

/** Ask GitHub now. Used by the Settings button, so failures are surfaced rather than swallowed. */
export async function checkForUpdate(): Promise<void> {
  const state = await window.fate.selfUpdate.check();
  if (state) updateStore.set(state);
  if (state?.stage === 'current') toast('success', `You are on the latest release (${state.current}).`);
  if (state?.stage === 'error' && state.error) toast('error', state.error);
}

export async function downloadUpdate(): Promise<void> {
  const state = await window.fate.selfUpdate.download();
  if (state) updateStore.set(state);
  if (state?.stage === 'error' && state.error) toast('error', state.error);
}

export async function cancelUpdateDownload(): Promise<void> {
  await window.fate.selfUpdate.cancel();
}

/**
 * Hand over to the new build. The window closes; a helper waits for this process to go and then
 * either runs the installer or swaps the portable exe.
 */
export async function installUpdate(): Promise<void> {
  const started = await window.fate.selfUpdate.install();
  if (!started) toast('error', 'This build cannot install an update for itself.');
}

/**
 * Hide the bar without changing anything.
 *
 * Deliberately not persisted: "not now" is about this sitting, and a preference that silently
 * suppresses an update notice forever is how software ends up years behind with the user believing
 * they are current. The next launch asks again.
 */
export function dismissUpdate(): void {
  updateStore.set((prev) => (prev.stage === 'idle' ? prev : { ...prev, stage: 'idle' }));
}

export async function relaunchElevated(): Promise<void> {
  const started = await window.fate.elevation.relaunch();
  if (!started) toast('info', 'Elevation was declined — nothing was changed.');
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// ── bootstrap ─────────────────────────────────────────────────────────────────────────────────

/** Wire up push events and pull the initial state. Called once from `main.tsx`. */
export async function initialise(): Promise<void> {
  window.fate.providers.onUpdate((list) => providersStore.set(list));
  window.fate.scan.onUpdate((snapshot) => scanStore.set(snapshot));
  window.fate.run.onUpdate((snapshot) => runStore.set(snapshot));
  window.fate.settings.onUpdate((settings) => settingsStore.set(settings));
  window.fate.selfUpdate.onUpdate((state) => updateStore.set(state));

  window.fate.log.onAppend((batch) => {
    logStore.set((prev) => {
      const next = prev.length + batch.length > RENDERER_LOG_CAP
        ? [...prev, ...batch].slice(-RENDERER_LOG_CAP)
        : [...prev, ...batch];
      return next;
    });
  });

  const [info, settings, providers, scan, run, logs, elevation, update] = await Promise.all([
    window.fate.getAppInfo(),
    window.fate.settings.get(),
    window.fate.providers.list(),
    window.fate.scan.snapshot(),
    window.fate.run.snapshot(),
    window.fate.log.snapshot(),
    window.fate.elevation.state(),
    window.fate.selfUpdate.state(),
  ]);

  appInfoStore.set(info);
  settingsStore.set(settings);
  providersStore.set(providers);
  scanStore.set(scan);
  runStore.set(run);
  logStore.set(logs.slice(-RENDERER_LOG_CAP));
  elevationStore.set(elevation);
  if (update) updateStore.set(update);

  applyMotion();
}

// ── derived reads ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the app is offering, before any UI filter.
 *
 * This is the number that means "updates waiting", and it is deliberately the ONLY definition of it.
 * The title bar used to count `scan.items` while the stat tile counted the filtered list, so a scan
 * that found 78 packages of which 2 had an unreadable installed version showed "78 updates waiting"
 * in the title bar, "76" in the tile beneath it, and 76 rows in the table. Same words, two numbers,
 * one screen.
 */
export function offeredItems(scan: ScanSnapshot, settings: AppSettings): ScanSnapshot['items'] {
  if (settings.includeUncertain) return scan.items;
  return scan.items.filter((item) => !item.uncertain);
}

/** How many offered updates each manager accounts for. Drives the sidebar counts. */
export function countsByProvider(
  scan: ScanSnapshot,
  settings: AppSettings,
): Map<ProviderId, number> {
  const counts = new Map<ProviderId, number>();
  for (const item of offeredItems(scan, settings)) {
    counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
  }
  return counts;
}

/**
 * The rows the table should show: everything offered, narrowed by the sidebar filter and the search
 * box.
 *
 * The search covers the install location as well as the name, the id and the source — with a location
 * column on screen, "site-packages" and "Program Files" are things people will reasonably type.
 */
export function visibleItems(
  scan: ScanSnapshot,
  ui: UiState,
  settings: AppSettings,
): ScanSnapshot['items'] {
  const needle = ui.query.trim().toLowerCase();

  return offeredItems(scan, settings).filter((item) => {
    if (ui.providerFilter && item.provider !== ui.providerFilter) return false;
    if (needle.length === 0) return true;
    return (
      item.name.toLowerCase().includes(needle) ||
      item.id.toLowerCase().includes(needle) ||
      (item.source?.toLowerCase().includes(needle) ?? false) ||
      (item.location?.toLowerCase().includes(needle) ?? false)
    );
  });
}
