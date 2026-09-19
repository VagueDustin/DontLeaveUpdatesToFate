/**
 * session.ts: everything the app knows, in one object.
 *
 * The alternative (a Scanner, an Updater and a ProviderRegistry that all mutate shared state) meant
 * three objects holding references to each other and to the log. One owner is easier to reason about
 * and gives exactly one place that pushes state to the renderer.
 *
 * Scans run concurrently: they are network-bound and independent. Upgrades run strictly one at a
 * time: two installers writing to the same Program Files tree is how you corrupt an install, and a
 * single stream is also the only way the terminal readout stays readable.
 */

import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  JobState,
  LogExportFormat,
  LogLevel,
  LogLine,
  ProviderId,
  ProviderInfo,
  ProviderScanResult,
  RunSnapshot,
  ScanSnapshot,
  UpdateItem,
} from '../shared/types.js';
import { isSkipped } from '../shared/types.js';
import type { CommandResult, StreamName } from './exec.js';
import { isElevated, looksLikePermissionFailure } from './elevation.js';
import { LogStore, type ExportMeta, type ExportPackage } from './logstore.js';
import { getProvider, providers, type Provider, type ProviderRuntime } from './providers/index.js';
import type { SettingsStore } from './settings.js';
import { diffBrokenShortcuts, takeShortcutCensus, type ShortcutCensus } from './shortcuts.js';
import { classifyStderr } from './text.js';

export interface SessionSinks {
  onLog: (batch: LogLine[]) => void;
  onScan: (snapshot: ScanSnapshot) => void;
  onRun: (snapshot: RunSnapshot) => void;
  onProviders: (list: ProviderInfo[]) => void;
}

/** How long a provider probe may take. Short: it is only asking for a version string. */
const PROBE_TIMEOUT_MS = 12_000;

const emptyScan = (): ScanSnapshot => ({
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  inFlight: [],
  results: [],
  items: [],
});

const emptyRun = (): RunSnapshot => ({
  id: '',
  phase: 'idle',
  startedAt: null,
  finishedAt: null,
  jobs: [],
  activeKey: null,
  brokenShortcuts: [],
});

export class Session {
  readonly log: LogStore;
  private infos: ProviderInfo[] = [];
  private scanState: ScanSnapshot = emptyScan();
  private runState: RunSnapshot = emptyRun();
  private scanAbort: AbortController | null = null;
  private runAbort: AbortController | null = null;
  /**
   * The items the current run is acting on.
   *
   * Kept because a successful upgrade is removed from `scanState.items` as soon as the run finishes,
   * correct for the table, fatal for an export that wants to list what was updated and where it lives.
   */
  private runItems = new Map<string, UpdateItem>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly sinks: SessionSinks,
  ) {
    this.log = new LogStore(sinks.onLog);
  }

  // ── state accessors ─────────────────────────────────────────────────────────────────────────

  get providerInfos(): ProviderInfo[] {
    return this.infos;
  }

  get scanSnapshot(): ScanSnapshot {
    return this.scanState;
  }

  get runSnapshot(): RunSnapshot {
    return this.runState;
  }

  /**
   * Counted from the jobs themselves rather than kept in a parallel counter.
   *
   * The counter version drifted the moment anything touched a job outside the main loop, a retry
   * pass reset it to zero while the table still showed 73 successful rows, so the export header and
   * the screen disagreed about the same run. There is only one place the truth can live.
   */
  get counters(): { updated: number; failed: number; skipped: number } {
    let updated = 0;
    let failed = 0;
    let skipped = 0;
    for (const job of this.runState.jobs) {
      if (job.status === 'success') updated++;
      else if (job.status === 'failed') failed++;
      else if (job.status === 'skipped') skipped++;
    }
    return { updated, failed, skipped };
  }

  logSnapshot(): LogLine[] {
    return this.log.snapshot();
  }

  // ── provider probing ────────────────────────────────────────────────────────────────────────

  /** Detect which managers are installed and usable. Cheap enough to run on every window open. */
  async refreshProviders(): Promise<ProviderInfo[]> {
    const disabled = new Set(this.settings.value.disabledProviders);

    const probed = await Promise.all(
      providers.map(async (provider): Promise<ProviderInfo> => {
        const base = {
          id: provider.id,
          label: provider.label,
          command: provider.command,
          kind: provider.kind,
          blurb: provider.blurb,
          needsElevation: provider.needsElevation,
        };

        try {
          const result = await provider.probe(PROBE_TIMEOUT_MS);
          const off = disabled.has(provider.id);
          return {
            ...base,
            available: result.available && !off,
            binary: result.binary,
            version: result.version,
            unavailable: off ? 'disabled' : result.unavailable,
            unavailableDetail: off ? 'Switched off in settings.' : result.unavailableDetail,
            environments: result.environments,
          };
        } catch (error) {
          return {
            ...base,
            available: false,
            binary: null,
            version: null,
            unavailable: 'incapable',
            unavailableDetail: describeError(error),
            environments: [],
          };
        }
      }),
    );

    this.infos = probed;
    this.sinks.onProviders(this.infos);
    return this.infos;
  }

  /** Re-apply the enabled/disabled flags without re-probing every binary. */
  applyDisabledFlags(): void {
    const disabled = new Set(this.settings.value.disabledProviders);
    this.infos = this.infos.map((info) => {
      const off = disabled.has(info.id);
      const wasOff = info.unavailable === 'disabled';
      if (off === wasOff) return info;

      if (off) {
        return { ...info, available: false, unavailable: 'disabled', unavailableDetail: 'Switched off in settings.' };
      }
      // Re-enabling: a binary we found earlier is available again; one we never found is not.
      const usable = info.binary !== null;
      return {
        ...info,
        available: usable,
        unavailable: usable ? null : 'missing',
        unavailableDetail: usable ? null : `${info.command} is not on PATH.`,
      };
    });
    this.sinks.onProviders(this.infos);
  }

  // ── scanning ────────────────────────────────────────────────────────────────────────────────

  get isScanning(): boolean {
    return this.scanState.phase === 'scanning';
  }

  async startScan(): Promise<ScanSnapshot> {
    if (this.isScanning) return this.scanState;
    if (this.runState.phase === 'running') return this.scanState;

    const targets = this.infos.filter((info) => info.available);
    const abort = new AbortController();
    this.scanAbort = abort;

    /**
     * Discard the previous run before scanning.
     *
     * Without this, a rescan keeps the old tally and the old per-row job statuses: the tiles still read
     * "225 updated · 4 failed" from a finished run, the title bar still says "4 updates failed", and any
     * package that is STILL outdated shows a green "Updated" badge next to a pending upgrade, because
     * jobs are matched to rows by key and the keys are stable across scans. A new scan is a new context.
     */
    this.runState = emptyRun();
    this.pushRun();

    this.scanState = {
      phase: 'scanning',
      startedAt: Date.now(),
      finishedAt: null,
      inFlight: targets.map((t) => t.id),
      results: [],
      items: [],
    };
    this.pushScan();

    this.log.rule(`Scanning ${targets.length} package manager(s)`);

    if (targets.length === 0) {
      this.log.append('No usable package managers were found on this system.', 'warn');
      this.scanState = { ...this.scanState, phase: 'done', finishedAt: Date.now(), inFlight: [] };
      this.log.drain();
      this.pushScan();
      return this.scanState;
    }

    const timeoutMs = this.settings.value.scanTimeoutSec * 1000;

    await Promise.all(
      targets.map(async (info) => {
        const provider = getProvider(info.id);
        if (!provider) return;

        const startedAt = Date.now();
        let result: ProviderScanResult;

        try {
          const items = await provider.scan(info, this.runtimeFor(info.id, abort.signal, timeoutMs));
          result = {
            provider: info.id,
            status: abort.signal.aborted ? 'skipped' : 'ok',
            items,
            durationMs: Date.now() - startedAt,
            error: null,
          };
          if (!abort.signal.aborted) {
            this.log.append(
              items.length === 0
                ? `${info.label}: everything is current.`
                : `${info.label}: ${items.length} update(s) available.`,
              items.length === 0 ? 'success' : 'system',
              { provider: info.id },
            );
          }
        } catch (error) {
          const message = describeError(error);
          result = {
            provider: info.id,
            status: 'error',
            items: [],
            durationMs: Date.now() - startedAt,
            error: message,
          };
          this.log.append(`${info.label}: ${message}`, 'error', { provider: info.id });
        }

        // Drop skipped packages here, at the boundary, so nothing downstream, the table, the counts,
        // "Update all", the stat tiles, can offer something the user has declined.
        const rules = this.settings.value.skipped;
        const kept = result.items.filter((item) => !isSkipped(item, rules));
        const dropped = result.items.length - kept.length;
        if (dropped > 0) {
          this.log.append(
            `${info.label}: ${dropped} skipped by your rules.`,
            'system',
            { provider: info.id },
          );
        }
        result = { ...result, items: kept };

        // Merge as each provider lands so the table fills in progressively.
        this.scanState = {
          ...this.scanState,
          inFlight: this.scanState.inFlight.filter((id) => id !== info.id),
          results: [...this.scanState.results, result],
          items: sortItems([...this.scanState.items, ...result.items]),
        };
        this.pushScan();
      }),
    );

    const cancelled = abort.signal.aborted;
    this.scanState = {
      ...this.scanState,
      phase: cancelled ? 'cancelled' : 'done',
      finishedAt: Date.now(),
      inFlight: [],
    };
    this.scanAbort = null;

    /*
      Report the number the app is actually offering.
      `includeUncertain` is off by default and hides packages whose installed version the manager
      could not read, so a bare `items.length` announced "78 update(s) waiting" while every count on
      screen said 76. Same words, two numbers, one screen.
    */
    const hidden = this.settings.value.includeUncertain
      ? 0
      : this.scanState.items.filter((item) => item.uncertain).length;
    const total = this.scanState.items.length - hidden;
    const seconds = ((this.scanState.finishedAt! - this.scanState.startedAt!) / 1000).toFixed(1);
    this.log.append(
      cancelled
        ? 'Scan cancelled.'
        : `Scan complete in ${seconds}s, ${total} update(s) waiting.` +
          (hidden > 0
            ? ` ${hidden} hidden because the installed version is unknown; show them in Settings.`
            : ''),
      cancelled ? 'warn' : 'success',
    );

    this.log.drain();
    this.pushScan();
    return this.scanState;
  }

  cancelScan(): void {
    this.scanAbort?.abort();
  }

  // ── running upgrades ────────────────────────────────────────────────────────────────────────

  get isRunning(): boolean {
    return this.runState.phase === 'running';
  }

  /**
   * Upgrade the given items, one at a time, in provider order.
   *
   * Keys rather than items are passed in so the renderer cannot inject a package that was never
   * scanned: every key is resolved against the current scan results and anything unknown is dropped.
   *
   * `continueRun` folds the results into the run already on screen instead of starting a fresh one.
   * That is what the "Retry failed" button wants: retrying one package used to blank the record of the
   * other seventy-three that had just succeeded, because a new run means new jobs and the table draws
   * its status badges from them.
   */
  async startRun(keys: string[], continueRun = false): Promise<RunSnapshot> {
    if (this.isRunning || this.isScanning) return this.runState;

    const wanted = new Set(keys);
    const rules = this.settings.value.skipped;
    // Belt and braces: skipped packages are already absent from the scan, but re-checking here means a
    // stale key from the renderer can never resurrect one.
    const items = this.scanState.items.filter(
      (item) => wanted.has(item.key) && !isSkipped(item, rules),
    );
    if (items.length === 0) return this.runState;

    const abort = new AbortController();
    this.runAbort = abort;

    const carried =
      continueRun && this.runState.jobs.length > 0
        ? this.runState.jobs.filter((job) => !wanted.has(job.key))
        : [];

    if (carried.length === 0) this.runItems.clear();
    for (const item of items) this.runItems.set(item.key, item);

    const queued = items.map(
      (item): JobState => ({
        key: item.key,
        provider: item.provider,
        name: item.name,
        targetVersion: item.availableVersion,
        status: 'queued',
        exitCode: null,
        startedAt: null,
        finishedAt: null,
        detail: null,
        retryable: false,
      }),
    );

    this.runState = {
      id: carried.length > 0 ? this.runState.id : randomUUID(),
      phase: 'running',
      startedAt: carried.length > 0 ? (this.runState.startedAt ?? Date.now()) : Date.now(),
      finishedAt: null,
      activeKey: null,
      // A previous run's broken-shortcut warning belongs to that run; it is re-derived below.
      brokenShortcuts: [],
      jobs: [...carried, ...queued],
    };
    this.pushRun();

    this.log.rule(
      carried.length > 0
        ? `Retrying ${items.length} package(s)`
        : `Updating ${items.length} package(s)`,
    );
    const elevated = await isElevated();
    if (!elevated && items.some((i) => this.infos.find((p) => p.id === i.provider)?.needsElevation)) {
      this.log.append(
        'Not running as administrator, machine-wide packages may fail. Use "Restart as admin" if they do.',
        'warn',
      );
    }

    const timeoutMs = this.settings.value.updateTimeoutSec * 1000;

    /**
     * Census of shortcuts before anything is touched.
     *
     * Compared against the same census afterwards to name anything this run left unlaunchable, the
     * Epic Games Launcher case, where the upgrade succeeded and the shortcuts stopped working. Failure
     * to take it is not fatal; the diff is simply skipped.
     *
     * Only taken when the run can actually create a shortcut. Enumerating four Start Menu trees and
     * resolving every .lnk through COM takes seconds on a well-populated machine, and it is dead time
     * at both ends of the run, spending it before forty pip upgrades, none of which has ever written
     * a .lnk in its life, is pure cost. Announced in the log either way, because an unexplained pause
     * before the first package looks like a hang.
     */
    const shortcutsBefore =
      this.settings.value.verifyShortcuts && touchesShortcuts(items)
        ? await this.censusStep('Recording shortcut targets before the run.')
        : null;

    for (const [index, item] of items.entries()) {
      if (abort.signal.aborted) {
        this.patchJob(item.key, { status: 'cancelled', detail: 'Cancelled before it started.' });
        continue;
      }

      const info = this.infos.find((p) => p.id === item.provider);
      const provider = info ? getProvider(item.provider) : undefined;

      if (!info || !provider || !info.binary) {
        this.patchJob(item.key, {
          status: 'skipped',
          detail: `${item.provider} is no longer available.`,
        });
        continue;
      }

      this.runState = { ...this.runState, activeKey: item.key };
      this.patchJob(item.key, { status: 'running', startedAt: Date.now() });

      this.log.rule(
        `[${index + 1}/${items.length}] ${item.name}, ${item.currentVersion} → ${item.availableVersion}`,
        { provider: item.provider, jobKey: item.key },
      );

      let result: CommandResult;
      try {
        result = await provider.upgrade(
          item,
          info,
          this.runtimeFor(item.provider, abort.signal, timeoutMs, item.key),
        );
      } catch (error) {
        const detail = describeError(error);
        this.log.append(detail, 'error', { provider: item.provider, jobKey: item.key });
        this.patchJob(item.key, {
          status: 'failed',
          detail,
          finishedAt: Date.now(),
          exitCode: null,
          retryable: false,
        });
        continue;
      }

      const verdict = classify(item.provider, result);
      this.patchJob(item.key, {
        status: verdict.status,
        detail: verdict.detail,
        exitCode: result.code,
        finishedAt: Date.now(),
        retryable: verdict.retryable ?? false,
      });

      this.log.append(
        verdict.detail ?? (verdict.status === 'success' ? 'Updated.' : verdict.status),
        verdict.status === 'success' ? 'success' : verdict.status === 'failed' ? 'error' : 'warn',
        { provider: item.provider, jobKey: item.key },
      );
    }

    const cancelled = abort.signal.aborted;
    this.runState = {
      ...this.runState,
      phase: cancelled ? 'cancelled' : 'done',
      finishedAt: Date.now(),
      activeKey: null,
    };
    this.runAbort = null;

    const { updated, failed, skipped } = this.counters;
    this.log.append(
      `${cancelled ? 'Run cancelled' : 'Run complete'}, ${updated} updated · ${failed} failed · ${skipped} skipped.`,
      failed > 0 ? 'warn' : 'success',
    );

    // "Exit code 0" is not the same as "still works". Name anything this run left unlaunchable.
    if (shortcutsBefore && updated > 0) {
      const after = await this.censusStep('Checking those shortcuts still resolve.');
      if (after) {
        const broken = diffBrokenShortcuts(shortcutsBefore, after);
        if (broken.length > 0) {
          this.runState = { ...this.runState, brokenShortcuts: broken };
          this.log.append(
            `${broken.length} shortcut(s) stopped working during this run, an upgrade moved or removed its target.`,
            'error',
          );
          for (const entry of broken) {
            this.log.append(`  ${entry.name} → ${entry.target}`, 'error');
          }
        }
      }
    }

    this.log.drain();
    this.pushRun();

    // Anything that succeeded is no longer an available update.
    this.dropSucceededItems();

    /**
     * Re-probe the managers themselves.
     *
     * A run frequently upgrades the tools doing the work, this session took npm 11.17.0 → 12.0.2,
     * choco 2.7.2 → 2.7.3 and pip 26.1.2 → 26.2, and the sidebar went on reporting the versions read
     * at startup. Cheap (one `--version` each) and it keeps the reported state true.
     */
    if (!cancelled) {
      this.log.append('Re-reading package manager versions.', 'system');
      await this.refreshProviders();
      this.log.drain();
    }

    return this.runState;
  }

  cancelRun(): void {
    if (!this.isRunning) return;
    this.log.append('Cancelling, finishing the current package first.', 'warn');
    this.runAbort?.abort();
    // Mark everything not yet started so the UI reflects the decision immediately.
    this.runState = {
      ...this.runState,
      jobs: this.runState.jobs.map((job) =>
        job.status === 'queued'
          ? { ...job, status: 'cancelled', detail: 'Cancelled before it started.' }
          : job,
      ),
    };
    this.pushRun();
  }

  /** Remove updated packages from the scan list so the table reflects reality without a rescan. */
  private dropSucceededItems(): void {
    const done = new Set(
      this.runState.jobs.filter((job) => job.status === 'success').map((job) => job.key),
    );
    if (done.size === 0) return;

    this.scanState = {
      ...this.scanState,
      items: this.scanState.items.filter((item) => !done.has(item.key)),
      results: this.scanState.results.map((result) => ({
        ...result,
        items: result.items.filter((item) => !done.has(item.key)),
      })),
    };
    this.pushScan();
  }

  // ── settings ────────────────────────────────────────────────────────────────────────────────

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.settings.value.disabledProviders.join(',');
    const next = await this.settings.patch(patch);
    if (next.disabledProviders.join(',') !== before) this.applyDisabledFlags();
    return next;
  }

  // ── log export ──────────────────────────────────────────────────────────────────────────────

  async buildExport(format: LogExportFormat, appVersion: string, osVersion: string): Promise<string> {
    const meta: ExportMeta = {
      appVersion,
      electronVersion: process.versions.electron ?? 'unknown',
      osVersion,
      elevated: await isElevated(),
      providers: this.infos.map((p) => ({
        label: p.label,
        version: p.version,
        available: p.available,
      })),
      packages: this.exportPackages(),
      ...this.counters,
    };
    return this.log.export(format, meta);
  }

  /**
   * The inventory that goes into an export: what was found, what happened to it, and where it lives.
   *
   * Built from the union of the scan and the run rather than from either alone. A package that
   * upgraded successfully is dropped from `scanState.items` the moment the run ends, that is what
   * keeps the table honest, so taking the list from the scan would give an export in which the
   * seventy-three successes simply do not appear.
   */
  private exportPackages(): ExportPackage[] {
    const jobs = new Map(this.runState.jobs.map((job) => [job.key, job]));
    const seen = new Set<string>();
    const out: ExportPackage[] = [];

    const push = (
      key: string,
      name: string,
      id: string,
      provider: ProviderId,
      from: string,
      to: string,
      location: string | null,
    ): void => {
      if (seen.has(key)) return;
      seen.add(key);
      const job = jobs.get(key);
      out.push({
        name,
        id,
        provider,
        from,
        to,
        location,
        status: job?.status ?? null,
        detail: job?.detail ?? null,
      });
    };

    for (const item of this.scanState.items) {
      push(
        item.key,
        item.name,
        item.id,
        item.provider,
        item.currentVersion,
        item.availableVersion,
        item.location,
      );
    }
    // Anything the run touched that the scan has since dropped, i.e. everything that worked.
    for (const job of this.runState.jobs) {
      const item = this.runItems.get(job.key);
      push(
        job.key,
        job.name,
        item?.id ?? job.key,
        job.provider,
        item?.currentVersion ?? 'unknown',
        job.targetVersion,
        item?.location ?? null,
      );
    }

    return out;
  }

  clearLog(): void {
    this.log.clear();
    this.log.append('Log cleared.', 'system');
    this.log.drain();
  }

  dispose(): void {
    this.scanAbort?.abort();
    this.runAbort?.abort();
    this.log.dispose();
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private runtimeFor(
    provider: ProviderId,
    signal: AbortSignal,
    timeoutMs: number,
    jobKey: string | null = null,
  ): ProviderRuntime {
    const context = { provider, jobKey };
    return {
      signal,
      timeoutMs,
      emit: (text: string, level: LogLevel) => {
        this.log.append(text, level, context);
      },
      emitStream: (text: string, stream: StreamName) => {
        // The stream chooses the default level; the line's content can override it. See classifyStderr.
        this.log.append(text, stream === 'stderr' ? classifyStderr(text) : 'stdout', context);
      },
    };
  }

  /** Take a shortcut census, announcing it first, and never let a failure end the run. */
  private async censusStep(message: string): Promise<ShortcutCensus | null> {
    this.log.append(message, 'system');
    this.log.drain();

    const started = Date.now();
    const census = await takeShortcutCensus().catch(() => null);
    if (census === null) {
      this.log.append('Could not read the shortcut list; skipping that check.', 'warn');
      return null;
    }

    this.log.append(
      `${census.size} shortcut(s) read in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
      'system',
    );
    this.log.drain();
    return census;
  }

  private patchJob(key: string, patch: Partial<JobState>): void {
    this.runState = {
      ...this.runState,
      jobs: this.runState.jobs.map((job) => (job.key === key ? { ...job, ...patch } : job)),
    };
    this.pushRun();
  }

  private pushScan(): void {
    this.sinks.onScan(this.scanState);
  }

  private pushRun(): void {
    this.sinks.onRun(this.runState);
  }
}

/**
 * Managers whose upgrades can write, move or delete a Start Menu / Desktop shortcut.
 *
 * pip, npm, pnpm, cargo and rustup put files in a library directory and a shim on PATH; none of them
 * has ever created a .lnk. Only the three that run real Windows installers are worth the census.
 */
const SHORTCUT_WRITING_PROVIDERS = new Set<ProviderId>(['winget', 'chocolatey', 'scoop']);

function touchesShortcuts(items: readonly UpdateItem[]): boolean {
  return items.some((item) => SHORTCUT_WRITING_PROVIDERS.has(item.provider));
}

// ── result classification ─────────────────────────────────────────────────────────────────────

interface Verdict {
  status: JobState['status'];
  detail: string | null;
  /** True when a second attempt has a real chance, the caller offers a retry pass for these. */
  retryable?: boolean;
}

/**
 * Exit codes that mean "succeeded, but Windows wants a reboot". Treating these as failures would
 * make a perfectly good MSI install look broken.
 */
const REBOOT_CODES = new Set([1641, 3010]);

/**
 * winget's HRESULTs, transcribed from `AppInstallerErrors.h` in microsoft/winget-cli.
 *
 * Keyed by hex string because that is how they are documented and searched; Node reports the exit code
 * as a signed 32-bit integer, so `hresultOf()` converts before lookup. An earlier hand-written version
 * of this table had labels shifted by one, `0x8A150010` described as a hash mismatch when it is
 * `NO_APPLICABLE_INSTALLER`, and, worse, mapped `0x8A150109` to "must run as administrator" when it
 * actually means REBOOT_REQUIRED_TO_FINISH. That turned successful installs into reported failures.
 *
 * Three classes matter:
 *   success  ,  it worked; Windows just wants a reboot.
 *   skipped  ,  winget structurally cannot do this. Retrying is pointless.
 *   failed   ,  genuinely failed; `retryable` marks the ones worth a second attempt.
 */
const WINGET_CODES = new Map<string, Verdict>([
  // ── succeeded, pending a reboot ────────────────────────────────────────────────────────────
  ['0x8A150109', { status: 'success', detail: 'Updated. Windows needs a restart to finish.' }],
  ['0x8A15010A', { status: 'success', detail: 'Updated. A restart is required before it can be used.' }],
  ['0x8A15010B', { status: 'success', detail: 'Updated. A restart has already been initiated.' }],
  ['0x8A15010D', { status: 'success', detail: 'Already at the latest version.' }],

  // ── nothing to do / winget cannot ──────────────────────────────────────────────────────────
  ['0x8A15002B', { status: 'skipped', detail: 'winget found no applicable upgrade for this package.' }],
  ['0x8A150014', { status: 'skipped', detail: 'No package matching that id is available any more.' }],
  ['0x8A150010', { status: 'skipped', detail: 'No installer in the manifest applies to this system.' }],
  ['0x8A150061', { status: 'skipped', detail: 'Already installed at this version.' }],
  ['0x8A150068', { status: 'skipped', detail: 'Pinned in winget. Unpin it first.' }],
  ['0x8A150069', { status: 'skipped', detail: 'This is a Store stub package; winget cannot upgrade it.' }],
  ['0x8A15004F', { status: 'skipped', detail: 'The available version is not newer than what is installed.' }],
  ['0x8A150050', { status: 'skipped', detail: 'The installed version is unknown, so winget will not upgrade it.' }],
  ['0x8A15010E', { status: 'skipped', detail: 'That would be a downgrade.' }],
  ['0x8A150114', { status: 'skipped', detail: 'This package does not support upgrading in place.' }],
  [
    '0x8A15008E',
    {
      status: 'skipped',
      detail:
        'Installed by a different technology than the manifest offers, so winget cannot upgrade it in place. Reinstall it to bring it under winget.',
    },
  ],

  // ── in use: the single most common recoverable failure ─────────────────────────────────────
  ['0x8A150101', { status: 'failed', detail: 'The package is in use. Close it and retry.', retryable: true }],
  ['0x8A150103', { status: 'failed', detail: 'A file it needs is in use. Close the app and retry.', retryable: true }],
  [
    '0x8A150111',
    {
      status: 'failed',
      detail: 'In use by a running application. Close it (and any background service it runs) and retry.',
      retryable: true,
    },
  ],
  ['0x8A150102', { status: 'failed', detail: 'Another install is already in progress. Retry shortly.', retryable: true }],

  // ── transient ─────────────────────────────────────────────────────────────────────────────
  ['0x8A150008', { status: 'failed', detail: 'The download failed.', retryable: true }],
  ['0x8A15002E', { status: 'failed', detail: 'The download was the wrong size.', retryable: true }],
  ['0x8A150086', { status: 'failed', detail: 'The downloaded installer was empty.', retryable: true }],
  ['0x8A150107', { status: 'failed', detail: 'No network connection.', retryable: true }],
  ['0x8A15006D', { status: 'failed', detail: 'The source service is unavailable.', retryable: true }],

  // ── permanent ─────────────────────────────────────────────────────────────────────────────
  ['0x8A150011', { status: 'failed', detail: 'The installer hash did not match. Nothing was installed.' }],
  ['0x8A15002D', { status: 'failed', detail: 'The installer failed its security check.' }],
  ['0x8A150006', { status: 'failed', detail: 'The installer ran but reported failure.', retryable: true }],
  ['0x8A150049', { status: 'failed', detail: 'The MSI install failed.', retryable: true }],
  ['0x8A150019', { status: 'failed', detail: 'This needs administrator rights. Use "Restart as admin".' }],
  ['0x8A150056', { status: 'failed', detail: 'The installer refuses to run elevated. Run unelevated.' }],
  ['0x8A150104', { status: 'failed', detail: 'A dependency is missing.' }],
  ['0x8A150105', { status: 'failed', detail: 'Not enough disk space.' }],
  ['0x8A150106', { status: 'failed', detail: 'Not enough memory.' }],
  ['0x8A15010F', { status: 'failed', detail: 'Blocked by system policy.' }],
  ['0x8A150113', { status: 'failed', detail: 'This system is not supported by the package.' }],
  ['0x8A15010C', { status: 'cancelled', detail: 'Cancelled during install.' }],
  ['0x8A150041', { status: 'failed', detail: 'Package agreements were not accepted.' }],
]);

/**
 * winget documents its exit codes as hex HRESULTs; Node hands us a number. Normalise for lookup.
 *
 * THE SIGN IS NOT DEPENDABLE, and assuming it was cost three packages their correct status. This
 * function used to bail on any non-negative code, on the stated premise that Node always reports an
 * exit code as a signed 32-bit int. It does not: on a real run, winget's
 * INSTALL_TECHNOLOGY_DIFFERENT arrived as the UNSIGNED 2316632206 rather than as -1978335090, so the
 * guard returned null, WINGET_CODES was never consulted, and three packages that winget had
 * structurally refused (`skipped`, not retryable, with an explanation) were reported as plain
 * failures carrying an unsearchable decimal. The run summary said "4 failed" when it should have said
 * "1 failed · 3 skipped".
 *
 * `>>> 0` maps both representations onto the same unsigned value, so either arrives as the same key.
 *
 * The facility check is what keeps that honest. Every code in WINGET_CODES sits in 0x8A15xxxx, so
 * anything else is an installer's own exit status wearing a plausible shape, and reporting it as an
 * HRESULT would be inventing a provenance it does not have.
 */
function hresultOf(code: number): string | null {
  if (!Number.isInteger(code)) return null;
  const unsigned = code >>> 0;
  // The second `>>> 0` is not redundant. JavaScript's bitwise operators return a SIGNED int32, so
  // `unsigned & 0xffff0000` comes back negative for anything with the top bit set, which every
  // 0x8A15xxxx code has, and would never compare equal to the positive facility constant.
  if (((unsigned & 0xffff0000) >>> 0) !== 0x8a150000) return null;
  return `0x${unsigned.toString(16).toUpperCase()}`;
}

function classify(provider: ProviderId, result: CommandResult): Verdict {
  if (result.cancelled) return { status: 'cancelled', detail: 'Cancelled.' };
  if (result.timedOut) {
    return { status: 'failed', detail: 'Timed out; the process was killed.', retryable: true };
  }
  if (result.spawnFailed) {
    return { status: 'failed', detail: firstUsefulLine(result) ?? 'The command could not be started.' };
  }
  if (result.code === 0) return { status: 'success', detail: null };

  if (result.code !== null && REBOOT_CODES.has(result.code)) {
    return { status: 'success', detail: 'Updated. Windows needs a restart to finish.' };
  }

  const hresult = result.code === null ? null : hresultOf(result.code);

  if (provider === 'winget' && hresult) {
    const known = WINGET_CODES.get(hresult);
    // Always append the HRESULT: "-1978335090" cannot be searched for, "0x8A15008E" can.
    if (known) {
      return { ...known, detail: known.detail ? `${known.detail} (${hresult})` : hresult };
    }
  }

  /*
    Every failure detail carries the code, including the two recognised-by-text cases below.
    Without it, an OBS upgrade that failed with 0x8A150111 reported only "Something is using this
    package", true, unsearchable, and indistinguishable in an exported log from the same message
    raised by choco for an entirely different reason.
  */
  const suffix = hresult ? ` (${hresult})` : result.code === null ? '' : ` (exit ${result.code})`;

  const combined = `${result.stderr}\n${result.stdout}`;
  if (looksLikePermissionFailure(combined)) {
    return {
      status: 'failed',
      detail: `Access denied, this package needs an elevated process. Try "Restart as admin".${suffix}`,
    };
  }

  // "in use" phrasing varies by installer; catching it generically covers the non-winget providers.
  if (/in use|being used by another|locked by|close .{0,30}and try again/i.test(combined)) {
    return {
      status: 'failed',
      detail: `Something is using this package. Close it and retry.${suffix}`,
      retryable: true,
    };
  }

  const detail = firstUsefulLine(result);
  return {
    status: 'failed',
    detail: detail ? `${detail}${suffix}` : `Failed${suffix}.`,
    // A bare non-zero exit with no recognised cause is worth one retry.
    retryable: true,
  };
}

/** Pick the line most likely to explain a failure: the last error-ish line, else the last line. */
function firstUsefulLine(result: CommandResult): string | null {
  const candidates = result.lines.filter((line) => line.trim().length > 0);
  if (candidates.length === 0) return null;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const line = candidates[i]!;
    if (/error|fail|denied|cannot|unable|not found|invalid|refus/i.test(line)) {
      return truncate(line, 240);
    }
  }
  return truncate(candidates[candidates.length - 1]!, 240);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Group by provider (registry order), then by display name, so the table is stable across scans. */
function sortItems(items: UpdateItem[]): UpdateItem[] {
  const order = new Map<ProviderId, number>(providers.map((p: Provider, i: number) => [p.id, i]));
  return [...items].sort((a, b) => {
    const pa = order.get(a.provider) ?? 99;
    const pb = order.get(b.provider) ?? 99;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

/**
 * Exported for tests.
 *
 * `hresultOf` and `classify` decide what the user is told about every failed upgrade, and until the
 * sign bug above neither had a single test. The one thing that would have caught it is asserting the
 * unsigned form, so that is what tests/verdicts.test.ts does.
 */
export const __test = { hresultOf, classify, WINGET_CODES };
