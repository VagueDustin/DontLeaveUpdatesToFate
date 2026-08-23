/**
 * self-update.ts — the update lifecycle, and the one place that decides to replace this app.
 *
 * `release.ts` knows how to talk to GitHub. This owns the state machine on top of it: idle → checking
 * → available → downloading → ready, plus the two ways of actually installing, one per build kind.
 *
 * The handover is the interesting part, and it reuses the lesson `elevation.ts` already paid for: a
 * detached PowerShell helper waits for THIS process to exit and only then touches the files. You
 * cannot replace a running executable on Windows, and racing the exit is how you get a half-written
 * binary. `Wait-Process` removes the race instead of trying to win it.
 */

import { spawn } from 'node:child_process';
import type { UpdateChannel, UpdateState } from '../shared/types.js';
import {
  assetFor,
  describe as describeRelease,
  downloadAsset,
  fetchDigest,
  fetchLatestRelease,
  isNewer,
  pruneDownloads,
  UpdateError,
  type Asset,
  type Release,
} from './release.js';
import type { LogLevel } from '../shared/types.js';

export interface SelfUpdaterDeps {
  currentVersion: string;
  channel: UpdateChannel;
  /** Where downloads land. Cleared of anything stale on the first check. */
  downloadDir: string;
  /** The executable this build should replace when it installs — null for `dev`. */
  targetExe: string | null;
  log: (text: string, level: LogLevel) => void;
  onState: (state: UpdateState) => void;
}

/** How often the download progress is pushed to the renderer. One frame at 20fps. */
const PROGRESS_MS = 50;

export class SelfUpdater {
  private state: UpdateState;
  private release: Release | null = null;
  private abort: AbortController | null = null;
  private lastPush = 0;

  constructor(private readonly deps: SelfUpdaterDeps) {
    this.state = {
      stage: 'idle',
      current: deps.currentVersion,
      channel: deps.channel,
      release: null,
      received: 0,
      total: 0,
      downloaded: null,
      verified: false,
      checkedAt: null,
      error: null,
    };
  }

  get snapshot(): UpdateState {
    return this.state;
  }

  /**
   * Ask GitHub whether there is anything newer.
   *
   * `quiet` is for the automatic check at launch: a failure there is written to the transcript but
   * must not put a red banner in front of someone who never asked. A manual check is the opposite —
   * the user pressed a button and is owed an answer either way.
   */
  async check(quiet = false): Promise<UpdateState> {
    if (this.state.stage === 'checking' || this.state.stage === 'downloading') return this.state;

    const abort = new AbortController();
    this.abort = abort;
    this.patch({ stage: 'checking', error: null });

    try {
      const release = await fetchLatestRelease(this.deps.currentVersion, abort.signal);
      this.release = release;

      const info = describeRelease(release, this.deps.channel);
      const newer = isNewer(this.deps.currentVersion, release.version);

      if (!newer) {
        this.deps.log(
          `This is the latest release (${this.deps.currentVersion}).`,
          quiet ? 'system' : 'success',
        );
        this.patch({ stage: 'current', release: info, checkedAt: Date.now() });
        return this.state;
      }

      this.deps.log(
        `Version ${release.version} is available — you are on ${this.deps.currentVersion}.`,
        'warn',
      );
      if (!info.assetName) {
        this.deps.log(
          `That release has no ${this.deps.channel} build attached, so it has to be installed by hand.`,
          'warn',
        );
      }
      this.patch({ stage: 'available', release: info, checkedAt: Date.now() });

      // Anything downloaded for an older release is now only a way to install the wrong version.
      void pruneDownloads(this.deps.downloadDir);
      return this.state;
    } catch (error) {
      const message = error instanceof UpdateError ? error.message : String(error);
      this.deps.log(`Could not check for updates: ${message}`, quiet ? 'warn' : 'error');
      this.patch({
        // A failed automatic check must not look like a failed run. It stays idle and says so in the
        // log; only a check the user asked for is allowed to surface an error state.
        stage: quiet ? 'idle' : 'error',
        error: quiet ? null : message,
        checkedAt: Date.now(),
      });
      return this.state;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Fetch the asset for this build kind and verify it. */
  async download(): Promise<UpdateState> {
    if (this.state.stage === 'downloading') return this.state;
    if (!this.release) return this.state;

    const asset = assetFor(this.release.assets, this.deps.channel);
    if (!asset) {
      this.patch({ stage: 'error', error: 'That release has no build for this kind of install.' });
      return this.state;
    }

    const abort = new AbortController();
    this.abort = abort;
    this.patch({ stage: 'downloading', received: 0, total: asset.size, error: null, downloaded: null });
    this.deps.log(`Downloading ${asset.name} (${megabytes(asset.size)}).`, 'system');

    try {
      const digest = await fetchDigest(
        this.release,
        asset,
        this.deps.currentVersion,
        abort.signal,
      ).catch(() => null);

      if (!digest) {
        this.deps.log(
          'That release publishes no checksum for this file; only its size can be checked.',
          'warn',
        );
      }

      const result = await downloadAsset(
        asset,
        digest,
        this.deps.downloadDir,
        this.deps.currentVersion,
        abort.signal,
        (received, total) => this.progress(received, total),
      );

      this.deps.log(
        digest
          ? `Downloaded and verified against the published SHA-256 (${digest.slice(0, 12)}…).`
          : 'Downloaded. No published checksum to verify it against.',
        digest ? 'success' : 'warn',
      );

      this.patch({
        stage: 'ready',
        downloaded: result.path,
        verified: digest !== null,
        received: asset.size,
        total: asset.size,
      });
      void pruneDownloads(this.deps.downloadDir, asset.name);
      return this.state;
    } catch (error) {
      const message = error instanceof UpdateError ? error.message : String(error);
      const cancelled = abort.signal.aborted;
      this.deps.log(cancelled ? 'Download cancelled.' : message, cancelled ? 'warn' : 'error');
      this.patch({
        stage: cancelled ? 'available' : 'error',
        error: cancelled ? null : message,
        received: 0,
        total: 0,
      });
      return this.state;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Hand off to the downloaded build. Returns true once the helper is running, at which point the
   * caller must quit — the helper is waiting on this process id.
   *
   * Both paths deliberately show the user what is happening. The installer runs its normal wizard
   * rather than `/S`, because silently replacing an application is not a thing software should do to
   * someone, even at their own request; and the portable path relaunches the new copy so the swap is
   * visible rather than something they discover next time.
   */
  install(): boolean {
    if (this.state.stage !== 'ready' || !this.state.downloaded) return false;
    if (this.deps.channel === 'dev' || !this.deps.targetExe) return false;

    const script =
      this.deps.channel === 'installed'
        ? installerScript(this.state.downloaded)
        : portableSwapScript(this.state.downloaded, this.deps.targetExe);

    this.deps.log(
      this.deps.channel === 'installed'
        ? 'Closing, then starting the installer.'
        : 'Closing, then replacing this portable build with the new one.',
      'system',
    );

    return runDetached(script);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private progress(received: number, total: number): void {
    const now = Date.now();
    // A hundred megabytes at 64KB a chunk is over a thousand callbacks; throttle to one frame.
    if (received < total && now - this.lastPush < PROGRESS_MS) return;
    this.lastPush = now;
    this.patch({ received, total });
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }
}

function megabytes(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1_048_576).toFixed(1)} MB` : 'unknown size';
}

/** Escape for a PowerShell single-quoted literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wait for this process, then run the installer.
 *
 * A 120-second cap on the wait rather than an unbounded one: if this process somehow does not exit,
 * the helper should give up rather than sit in the background forever holding a stale plan.
 */
function installerScript(installer: string): string {
  return [
    `Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath ${psQuote(installer)}`,
  ].join('; ');
}

/**
 * Wait for this process, then overwrite the portable exe in place and start it again.
 *
 * The retry loop is not defensive padding. The portable build is a stub that extracts the app to a
 * temp directory and runs it there, so `Wait-Process` on our own id returns while the STUB is still
 * shutting down — and until it does, its own image is mapped and cannot be overwritten. Four attempts
 * a second apart covers that overlap.
 *
 * If every attempt fails, the new build is started from where it was downloaded rather than leaving
 * the user with nothing: they get the new version now, and the old exe is still theirs to delete.
 */
function portableSwapScript(downloaded: string, target: string): string {
  const src = psQuote(downloaded);
  const dst = psQuote(target);
  return [
    `Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
    '$ok = $false',
    'for ($i = 0; $i -lt 4 -and -not $ok; $i++) {',
    '  Start-Sleep -Seconds 1',
    `  try { Copy-Item -LiteralPath ${src} -Destination ${dst} -Force -ErrorAction Stop; $ok = $true } catch { }`,
    '}',
    `if ($ok) { Remove-Item -LiteralPath ${src} -Force -ErrorAction SilentlyContinue; Start-Process -FilePath ${dst} }`,
    `else { Start-Process -FilePath ${src} }`,
  ].join('\n');
}

function runDetached(script: string): boolean {
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, stdio: 'ignore', detached: true },
    );
    child.on('error', () => {
      /* the caller has already returned; nothing useful to do */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
