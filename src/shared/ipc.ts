/**
 * ipc.ts — the channel names, in one place.
 *
 * Both sides import these constants rather than typing string literals, so a rename is a compile
 * error instead of a silently dead channel.
 */

export const IPC = {
  appInfo: 'app:info',

  providersList: 'providers:list',
  providersRefresh: 'providers:refresh',

  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',
  scanSnapshot: 'scan:snapshot',

  runStart: 'run:start',
  runCancel: 'run:cancel',
  runSnapshot: 'run:snapshot',

  logSnapshot: 'log:snapshot',
  logClear: 'log:clear',
  logExport: 'log:export',
  revealPath: 'shell:reveal',
  copyText: 'shell:copy',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  elevationState: 'elevation:state',
  elevationRelaunch: 'elevation:relaunch',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',

  openExternal: 'shell:open-external',
} as const;

/** Result of an export request. */
export interface ExportOutcome {
  saved: boolean;
  path: string | null;
  error: string | null;
}
