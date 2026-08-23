/**
 * preload — the only bridge between the renderer and the operating system.
 *
 * The renderer has no Node integration. Everything it can do is what this file explicitly exposes,
 * and every exposed function is a fixed verb: there is no `invoke(channel, args)` escape hatch, so a
 * compromised renderer cannot reach an arbitrary IPC channel.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ExportOutcome } from '../shared/ipc.js';
import type {
  AppInfo,
  AppSettings,
  ElevationState,
  FateEventName,
  FateEvents,
  LogExportFormat,
  LogLine,
  ProviderId,
  ProviderInfo,
  RunSnapshot,
  ScanSnapshot,
  UpdateState,
} from '../shared/types.js';

/** Subscribe to a main-process push event. Returns an unsubscribe function. */
function subscribe<K extends FateEventName>(
  channel: K,
  handler: (payload: FateEvents[K]) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: FateEvents[K]): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),

  providers: {
    list: (): Promise<ProviderInfo[]> => ipcRenderer.invoke(IPC.providersList),
    refresh: (): Promise<ProviderInfo[]> => ipcRenderer.invoke(IPC.providersRefresh),
    onUpdate: (handler: (list: ProviderInfo[]) => void) => subscribe('providers:update', handler),
  },

  scan: {
    start: (): Promise<ScanSnapshot> => ipcRenderer.invoke(IPC.scanStart),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.scanCancel),
    snapshot: (): Promise<ScanSnapshot> => ipcRenderer.invoke(IPC.scanSnapshot),
    onUpdate: (handler: (snapshot: ScanSnapshot) => void) => subscribe('scan:update', handler),
  },

  run: {
    start: (keys: string[], continueRun = false): Promise<RunSnapshot> =>
      ipcRenderer.invoke(IPC.runStart, keys, continueRun),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.runCancel),
    snapshot: (): Promise<RunSnapshot> => ipcRenderer.invoke(IPC.runSnapshot),
    onUpdate: (handler: (snapshot: RunSnapshot) => void) => subscribe('run:update', handler),
  },

  log: {
    snapshot: (): Promise<LogLine[]> => ipcRenderer.invoke(IPC.logSnapshot),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.logClear),
    export: (format: LogExportFormat): Promise<ExportOutcome> =>
      ipcRenderer.invoke(IPC.logExport, format),
    onAppend: (handler: (batch: LogLine[]) => void) => subscribe('log:append', handler),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
    onUpdate: (handler: (settings: AppSettings) => void) => subscribe('settings:update', handler),
  },

  selfUpdate: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateCheck),
    download: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateDownload),
    /** Resolves false when this build cannot install for itself, or nothing is downloaded. */
    install: (): Promise<boolean> => ipcRenderer.invoke(IPC.updateInstall),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.updateCancel),
    onUpdate: (handler: (state: UpdateState) => void) => subscribe('update:state', handler),
  },

  elevation: {
    state: (): Promise<ElevationState> => ipcRenderer.invoke(IPC.elevationState),
    relaunch: (): Promise<boolean> => ipcRenderer.invoke(IPC.elevationRelaunch),
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
    onState: (handler: (state: { maximized: boolean; focused: boolean }) => void) =>
      subscribe('window:state', handler),
  },

  /** Open Explorer with this file or folder selected. Resolves false when it is not there. */
  reveal: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.revealPath, path),

  /**
   * Put text on the clipboard, through the main process.
   *
   * `navigator.clipboard.writeText` would need a secure context and a granted `clipboard-write`
   * permission, neither of which is guaranteed for a `file://` renderer. Electron's own clipboard
   * module has no such conditions.
   */
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.copyText, text),

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.openExternal, url),
};

export type FateApi = typeof api;
export type { ProviderId };

contextBridge.exposeInMainWorld('fate', api);
