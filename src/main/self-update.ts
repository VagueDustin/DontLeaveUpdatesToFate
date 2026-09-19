/**
 * self-update.ts: the update lifecycle, and the one place that decides to replace this app.
 *
 * `release.ts` knows how to talk to GitHub. This owns the state machine on top of it: idle → checking
 * → available → downloading → ready, plus the two ways of actually installing, one per build kind.
 *
 * The handover is the interesting part, and it reuses the lesson `elevation.ts` already paid for: a
 * detached PowerShell helper waits for THIS process to exit and only then touches the files. You
 * cannot replace a running executable on Windows, and racing the exit is how you get a half-written
 * binary. `Wait-Process` removes the race instead of trying to win it.
 */

import { join } from 'node:path';
import { psQuote, startHandover } from './handover.js';
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
  /**
   * Where the downloaded build lands. Must be somewhere Windows will let us EXECUTE from.
   *
   * This is the user's Downloads folder, and that is not a stylistic choice. The obvious home for it
   * was `%APPDATA%\dont-leave-updates-to-fate\updates`, and on the machine this was developed against
   * that silently does not work: the file downloads and verifies perfectly, and `Start-Process` on it
   * fails with "the system cannot find the path specified" for a file that demonstrably exists.
   * Blocking execution from AppData is a common hardening measure, it is where a great deal of real
   * malware stages itself, and an updater that ignores it just quietly never updates anything.
   *
   * Downloads is where an installer would have gone if the user had fetched it themselves, so it is
   * the location least likely to be treated as suspicious, and the most obvious place to look when
   * something goes wrong and they want to run it by hand.
   */
  downloadDir: string;
  /**
   * Where the handover script and its log live. Never executed directly, PowerShell is the process,
   * the script is only an argument, so the restriction above does not apply and this stays in the
   * app's own data directory rather than littering Downloads.
   */
  workDir: string;
  /** The executable this build should replace when it installs, null for `dev`. */
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
   * must not put a red banner in front of someone who never asked. A manual check is the opposite,
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
        // Running the latest release means any installer still sitting in Downloads is, by
        // definition, one we no longer need. Only files matching this app's own artifact names are
        // ever touched, see `pruneDownloads`.
        void pruneDownloads(this.deps.downloadDir);
        return this.state;
      }

      this.deps.log(
        `Version ${release.version} is available, you are on ${this.deps.currentVersion}.`,
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
   * caller must quit, the helper is waiting on this process id.
   *
   * Both paths deliberately show the user what is happening. The installer runs its normal wizard
   * rather than `/S`, because silently replacing an application is not a thing software should do to
   * someone, even at their own request; and the portable path relaunches the new copy so the swap is
   * visible rather than something they discover next time.
   */
  install(): boolean {
    if (this.state.stage !== 'ready' || !this.state.downloaded) return false;
    if (this.deps.channel === 'dev' || !this.deps.targetExe) return false;

    const logPath = join(this.deps.workDir, 'handover.log');
    const script =
      this.deps.channel === 'installed'
        ? installerScript(this.state.downloaded, logPath)
        : portableSwapScript(this.state.downloaded, this.deps.targetExe, logPath);

    const outcome = startHandover(script, this.deps.workDir, 'handover.ps1');

    /*
      Say which mechanism started the helper, and its process id.
      This is the last line the app writes before it exits, and for a while it was the only thing
      standing between "the update did not happen" and no information at all.
    */
    this.deps.log(
      outcome.started
        ? `${
            this.deps.channel === 'installed'
              ? 'Closing, then starting the installer'
              : 'Closing, then replacing this portable build with the new one'
          } (${outcome.detail}).`
        : `Could not start the handover helper, ${outcome.detail}`,
      outcome.started ? 'system' : 'error',
    );

    return outcome.started;
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

/**
 * A line the helper appends to `updates\swap.log`.
 *
 * The helper runs after this process is gone, so if it fails there is nobody left to report to and
 * nothing on screen to notice. That is the same hole the elevated relaunch fell into, "the window
 * closed and nothing came back", with no evidence anywhere, and the same answer applies: leave a
 * trail. This one earned itself immediately; the first version of the portable swap failed silently
 * and the log is how the next one would be diagnosed in a minute rather than an hour.
 */
function logLine(logPath: string, message: string): string {
  return `Add-Content -LiteralPath ${psQuote(logPath)} -Value ("{0:o}  ${message}" -f (Get-Date)) -ErrorAction SilentlyContinue`;
}

/**
 * Wait for this process, then run the installer.
 *
 * A 120-second cap on the wait rather than an unbounded one: if this process somehow does not exit,
 * the helper should give up rather than sit in the background forever holding a stale plan.
 */
function installerScript(installer: string, logPath: string): string {
  return [
    logLine(logPath, `install: waiting for pid ${process.pid}`),
    `Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
    logLine(logPath, 'install: starting the installer'),
    'try {',
    // -Wait so the download can be removed afterwards. The installer lands in the user's Downloads
    // folder, and leaving a hundred megabytes of superseded installer in there is rude.
    `  Start-Process -FilePath ${psQuote(installer)} -Wait -ErrorAction Stop`,
    `  ${logLine(logPath, 'install: the installer finished')}`,
    `  Remove-Item -LiteralPath ${psQuote(installer)} -Force -ErrorAction SilentlyContinue`,
    '} catch {',
    /*
      If it will not start, say why and SHOW the user the file.
      This is the failure that cost hours: an installer downloaded to `%APPDATA%` verified perfectly
      and then would not launch, because a hardened Windows refuses to execute from there, and the
      only symptom was a window closing and nothing happening. Whatever the reason next time, the
      user ends up looking at the installer in Explorer rather than at nothing.
    */
    `  Add-Content -LiteralPath ${psQuote(logPath)} -Value ("{0:o}  install: could not start - {1}" -f (Get-Date), $_.Exception.Message) -ErrorAction SilentlyContinue`,
    `  Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,' + '\"' + ${psQuote(installer)} + '\"')`,
    '}',
  ].join('\n');
}

/**
 * Wait for this process, then overwrite the portable exe in place and start it again.
 *
 * WAITING FOR OUR OWN EXIT IS NOT ENOUGH, and the first version of this got it wrong. The portable
 * build is a stub: it extracts the app to a temp directory, runs it from there, and only when that
 * child exits does it delete a couple of hundred megabytes of extraction and quit. `Wait-Process` on
 * our id returns at the START of that, while the stub still has its own image mapped and the exe
 * cannot be written. Four retries a second apart looked like enough and was not, every attempt hit a
 * sharing violation and the update silently did not happen.
 *
 * So the wait is for the thing that actually matters: whether the file can be opened for writing with
 * no sharing. That is precisely the condition a copy needs, it is true the instant the stub lets go
 * however long that takes, and it costs nothing to test. Ninety seconds is the budget, which is far
 * more than the observed few, and it polls twice a second rather than once.
 *
 * If it never becomes writable, the new build is started from where it was downloaded rather than
 * leaving the user with nothing: they get the new version now, and the stale exe is still theirs.
 */
function portableSwapScript(downloaded: string, target: string, logPath: string): string {
  const src = psQuote(downloaded);
  const dst = psQuote(target);
  return [
    logLine(logPath, `swap: waiting for pid ${process.pid}`),
    `Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
    logLine(logPath, 'swap: process gone, waiting for the exe to become writable'),
    '$ok = $false',
    '$deadline = (Get-Date).AddSeconds(90)',
    '$last = ""',
    'while (-not $ok -and (Get-Date) -lt $deadline) {',
    '  try {',
    // No sharing: this fails while the stub still holds the image, and succeeds the moment it does not.
    `    $probe = [System.IO.File]::Open(${dst}, 'Open', 'Write', 'None')`,
    '    $probe.Close()',
    `    Copy-Item -LiteralPath ${src} -Destination ${dst} -Force -ErrorAction Stop`,
    '    $ok = $true',
    '  } catch {',
    '    $last = $_.Exception.Message',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    'if ($ok) {',
    `  ${logLine(logPath, 'swap: replaced, relaunching')}`,
    `  Remove-Item -LiteralPath ${src} -Force -ErrorAction SilentlyContinue`,
    `  Start-Process -FilePath ${dst}`,
    '} else {',
    `  Add-Content -LiteralPath ${psQuote(logPath)} -Value ("{0:o}  swap: gave up - {1}" -f (Get-Date), $last) -ErrorAction SilentlyContinue`,
    `  Start-Process -FilePath ${src}`,
    '}',
  ].join('\n');
}

/**
 * Exported for unit tests. These two strings are the only part of the update path that runs after the
 * app is gone, so they are also the only part nothing else can catch getting wrong.
 */
export const __test = { installerScript, portableSwapScript, psQuote };
