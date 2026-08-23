/**
 * main — app bootstrap, the window, and the IPC surface.
 *
 * The window is frameless: the title bar is drawn by the renderer so it can carry the Cinzel wordmark
 * and the gold hairline instead of Windows' default chrome. That is the single biggest contributor to
 * the app not looking like "an Electron app with a theme".
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { release } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PRODUCT_NAME, PRODUCT_SLUG, footerLine } from '../shared/brand.js';
import { SURFACE_BASE } from '../shared/brand-tokens.js';
import { IPC, type ExportOutcome } from '../shared/ipc.js';
import type {
  AppInfo,
  AppSettings,
  ElevationState,
  LogExportFormat,
  ProviderInfo,
  UpdateChannel,
  UpdateState,
} from '../shared/types.js';
import { isElevated, relaunchElevated } from './elevation.js';
import { LogStore, suggestedLogName } from './logstore.js';
import { SelfUpdater } from './self-update.js';
import { Session } from './session.js';
import { SettingsStore } from './settings.js';

/** True when launched from the single-file portable build rather than an installed copy. */
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

/**
 * Which artifact this is, and therefore which one an update should fetch.
 *
 * An unpackaged run reports `dev`: it may still check — that keeps the check itself exercisable
 * during development — but nothing is allowed to install over a working tree.
 */
function updateChannel(): UpdateChannel {
  if (!app.isPackaged) return 'dev';
  return IS_PORTABLE ? 'portable' : 'installed';
}

/**
 * The executable an update replaces.
 *
 * For the portable build that is the file the user double-clicked, NOT `app.getPath('exe')` — the
 * latter points into the temp directory the stub extracted to, which is deleted on exit. Overwriting
 * that would be overwriting something that is about to vanish.
 */
function updateTarget(): string | null {
  if (!app.isPackaged) return null;
  return IS_PORTABLE ? (process.env.PORTABLE_EXECUTABLE_FILE ?? null) : app.getPath('exe');
}

let mainWindow: BrowserWindow | null = null;
let session: Session | null = null;
let settings: SettingsStore | null = null;
let updater: SelfUpdater | null = null;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

/**
 * Append a line to `<userData>/startup.log`.
 *
 * Startup happens before the session log exists, so an instance that exits during the single-instance
 * handshake leaves no trace at all — which is exactly the failure that is hardest to diagnose, because
 * from the outside "nothing happened". This is a few bytes per launch and answers "why did it not open".
 */
function trace(message: string): void {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'startup.log'),
      `${new Date().toISOString()} pid=${process.pid} ${message}\n`,
      'utf8',
    );
  } catch {
    /* diagnostics must never break startup */
  }
}

/**
 * A second copy would fight the first over the same package managers, so only one runs.
 *
 * No coordination is needed for the elevated relaunch: `relaunchElevated` sequences the helper to wait
 * for this process to exit before starting the elevated copy, so the lock is always free by the time
 * the new instance asks for it. An earlier version tried to win that race with a handoff marker and a
 * liveness poll; sequencing removes the race instead of racing better.
 */
function acquireSingleInstanceLock(): boolean {
  const got = app.requestSingleInstanceLock();
  trace(`startup: requestSingleInstanceLock=${got}`);
  return got;
}

/** Push an event to the renderer, tolerating a window that is closing. */
function push(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    // Set here, not in CSS: Chromium paints this before the renderer's first frame, and the default
    // white would flash on every launch.
    backgroundColor: SURFACE_BASE,
    frame: false,
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxing would force the preload to be CommonJS while this package is ESM. Context
      // isolation with no node integration is what actually keeps the renderer contained: it has no
      // require, no process, and only the fixed verbs the preload exposes.
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Listed one by one rather than looped: BrowserWindow['on'] is a set of per-event overloads, so a
  // union of event names does not satisfy any single signature.
  const reportState = (): void =>
    push('window:state', { maximized: window.isMaximized(), focused: window.isFocused() });
  window.on('maximize', reportState);
  window.on('unmaximize', reportState);
  window.on('focus', reportState);
  window.on('blur', reportState);

  // Nothing in this app should ever navigate or open a second window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const isDev = !app.isPackaged && url.startsWith('http://localhost');
    if (!isDev) event.preventDefault();
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

/** Open a link in the user's browser, refusing anything that is not plain http(s). */
async function openExternal(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

function registerIpc(current: Session, store: SettingsStore): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    productName: PRODUCT_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    publisher: 'VagueDustin Enterprises',
    footer: footerLine(),
    portable: IS_PORTABLE,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle(IPC.providersList, (): ProviderInfo[] => current.providerInfos);
  ipcMain.handle(IPC.providersRefresh, () => current.refreshProviders());

  ipcMain.handle(IPC.scanStart, () => current.startScan());
  ipcMain.handle(IPC.scanCancel, () => current.cancelScan());
  ipcMain.handle(IPC.scanSnapshot, () => current.scanSnapshot);

  ipcMain.handle(IPC.runStart, (_event, keys: unknown, continueRun: unknown) => {
    // Trust nothing from the renderer: keys are re-validated against the current scan inside startRun.
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
    return current.startRun(list, continueRun === true);
  });
  ipcMain.handle(IPC.runCancel, () => current.cancelRun());
  ipcMain.handle(IPC.runSnapshot, () => current.runSnapshot);

  ipcMain.handle(IPC.logSnapshot, () => current.logSnapshot());
  ipcMain.handle(IPC.logClear, () => current.clearLog());
  ipcMain.handle(IPC.logExport, (_event, format: unknown): Promise<ExportOutcome> =>
    exportLog(current, normaliseFormat(format)),
  );
  /**
   * Show a file or folder in Explorer.
   *
   * Checked first, because `showItemInFolder` on a path that no longer exists opens a bare Explorer
   * window at some arbitrary place — which reads as a bug rather than as "that is gone". A missing
   * path falls back to its parent, and the boolean lets the renderer say so.
   */
  ipcMain.handle(IPC.revealPath, async (_event, path: unknown): Promise<boolean> => {
    if (typeof path !== 'string' || path.trim().length === 0) return false;
    const target = path.trim();

    if (existsSync(target)) {
      shell.showItemInFolder(target);
      return true;
    }
    const parent = dirname(target);
    if (parent !== target && existsSync(parent)) {
      await shell.openPath(parent);
      return true;
    }
    return false;
  });

  ipcMain.handle(IPC.settingsGet, (): AppSettings => store.value);
  ipcMain.handle(IPC.settingsSet, async (_event, patch: unknown): Promise<AppSettings> => {
    const next = await current.updateSettings(
      typeof patch === 'object' && patch !== null ? (patch as Partial<AppSettings>) : {},
    );
    push('settings:update', next);
    return next;
  });

  ipcMain.handle(IPC.updateState, (): UpdateState | null => updater?.snapshot ?? null);
  ipcMain.handle(IPC.updateCheck, () => updater?.check(false) ?? null);
  ipcMain.handle(IPC.updateDownload, () => updater?.download() ?? null);
  ipcMain.handle(IPC.updateCancel, () => updater?.cancel());

  ipcMain.handle(IPC.updateInstall, (): boolean => {
    const started = updater?.install() ?? false;
    if (!started) return false;

    // The helper is waiting on this pid, so exit promptly — same handover as the elevated relaunch.
    session?.dispose();
    app.releaseSingleInstanceLock();
    setTimeout(() => app.exit(0), 200);
    return true;
  });

  ipcMain.handle(IPC.elevationState, async (): Promise<ElevationState> => {
    const elevated = await isElevated();
    return {
      isElevated: elevated,
      recommended: current.providerInfos.some((p) => p.available && p.needsElevation),
    };
  });

  ipcMain.handle(IPC.elevationRelaunch, (): boolean => {
    // The portable build re-launches the exe the user double-clicked, not the extracted temp copy.
    const target = process.env.PORTABLE_EXECUTABLE_FILE ?? app.getPath('exe');
    trace(`elevate: relaunching ${target}`);

    const queued = relaunchElevated(target);
    trace(`elevate: helper queued=${queued}`);
    if (!queued) return false;

    // The helper is waiting on this pid, so exit promptly. Release the lock explicitly rather than
    // relying on teardown ordering.
    session?.dispose();
    app.releaseSingleInstanceLock();
    setTimeout(() => app.exit(0), 200);
    return true;
  });

  ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize());
  ipcMain.handle(IPC.windowMaximize, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle(IPC.windowClose, () => mainWindow?.close());

  ipcMain.handle(IPC.copyText, (_event, text: unknown): boolean => {
    // Bounded: the renderer only ever sends a filesystem path, and an unbounded string from a
    // compromised renderer should not become an unbounded clipboard allocation.
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return false;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle(IPC.openExternal, (_event, url: unknown) =>
    typeof url === 'string' ? openExternal(url) : Promise.resolve(false),
  );
}

function normaliseFormat(value: unknown): LogExportFormat {
  return value === 'json' || value === 'md' ? value : 'txt';
}

async function exportLog(current: Session, format: LogExportFormat): Promise<ExportOutcome> {
  const filters =
    format === 'json'
      ? [{ name: 'JSON', extensions: ['json'] }]
      : format === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'Text', extensions: ['txt', 'log'] }];

  const target = await dialog.showSaveDialog(mainWindow ?? undefined!, {
    title: 'Export update log',
    defaultPath: join(app.getPath('documents'), suggestedLogName(format, PRODUCT_SLUG)),
    filters,
  });

  if (target.canceled || !target.filePath) return { saved: false, path: null, error: null };

  try {
    const body = await current.buildExport(format, app.getVersion(), `${process.platform} ${release()}`);
    await writeFile(target.filePath, body, 'utf8');
    return { saved: true, path: target.filePath, error: null };
  } catch (error) {
    return {
      saved: false,
      path: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function bootstrap(): Promise<void> {
  // The lock check is async now (it may wait for an outgoing elevated handoff), so it runs alongside
  // Electron's own startup rather than blocking the module body.
  const gotLock = acquireSingleInstanceLock();
  if (!gotLock) {
    trace('startup: exiting, another instance holds the lock');
    app.quit();
    return;
  }

  await app.whenReady();
  trace('startup: proceeding to create the window');

  app.setAppUserModelId('com.vaguedustin.dontleaveupdatestofate');

  settings = new SettingsStore(SettingsStore.fileFor(app.getPath('userData')));
  await settings.load();
  trace('startup: settings loaded');

  session = new Session(settings, {
    onLog: (batch) => push('log:append', batch),
    onScan: (snapshot) => push('scan:update', snapshot),
    onRun: (snapshot) => push('run:update', snapshot),
    onProviders: (list) => push('providers:update', list),
  });

  updater = new SelfUpdater({
    currentVersion: app.getVersion(),
    channel: updateChannel(),
    downloadDir: join(app.getPath('userData'), 'updates'),
    targetExe: updateTarget(),
    log: (text, level) => {
      session?.log.append(text, level);
      session?.log.drain();
    },
    onState: (state) => push('update:state', state),
  });

  registerIpc(session, settings);
  trace('startup: ipc registered');
  mainWindow = createWindow();
  trace('startup: window constructed');
  mainWindow.once('ready-to-show', () => trace('startup: window ready-to-show'));
  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    trace(`startup: renderer gone reason=${d.reason}`),
  );
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    trace(`startup: did-fail-load ${code} ${desc}`),
  );

  // Mirror the transcript to disk from the very first line, so a run survives a crash or a close.
  const logDir = join(app.getPath('userData'), 'logs');
  const logFile = session.log.openFile(logDir, PRODUCT_SLUG);
  void LogStore.prune(logDir);

  // Recorded at startup so "did the elevated relaunch actually elevate?" is answerable from the log
  // rather than inferred from outside the process, where every signal is ambiguous.
  void isElevated().then((elevated) => {
    trace(`startup: elevated=${elevated}`);
    session?.log.append(
      elevated ? 'Running as administrator.' : 'Running without administrator rights.',
      elevated ? 'success' : 'warn',
    );
  });

  session.log.append(`${PRODUCT_NAME} ${app.getVersion()} ready.`, 'system');
  if (logFile) session.log.append(`Session log: ${logFile}`, 'system');

  // Probe after the window exists so the sidebar can animate the results in as they arrive.
  const infos = await session.refreshProviders();
  const usable = infos.filter((info) => info.available).length;
  session.log.append(
    `${usable} of ${infos.length} package managers available on this system.`,
    'system',
  );
  session.log.drain();

  if (settings.value.scanOnLaunch) void session.startScan();

  /*
    The self-check goes last, and quietly.
    It is one request to api.github.com, and it is the only network call this app makes on its own —
    everything else is a package manager the user asked to run. Doing it after the scan has started
    keeps it off the path to first paint, and `quiet` means a failure lands in the transcript rather
    than in front of someone who did not ask.
  */
  if (settings.value.checkForUpdates) void updater.check(true);
}

// Traced rather than left to float: an exception here previously produced a process that exited with no
// window and no explanation anywhere.
void bootstrap().catch((error: unknown) => {
  trace(`startup: FAILED ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
});

app.on('quit', (_event, code) => trace(`startup: app quit code=${code}`));
app.on('before-quit', () => trace('startup: before-quit'));

app.on('window-all-closed', () => {
  session?.dispose();
  app.quit();
});

app.on('before-quit', () => {
  session?.dispose();
});
