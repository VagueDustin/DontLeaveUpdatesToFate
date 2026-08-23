/**
 * elevation.ts — administrator detection and relaunch.
 *
 * `winget` and `choco` both install machine-wide, so without elevation a run can get most of the way
 * through and then fail on every package. Detecting it up front and offering one button is far kinder
 * than letting the user read forty "Access is denied" traces.
 *
 * There is no Node API for "am I elevated" on Windows. `net session` is the cheapest reliable probe:
 * it enumerates SMB sessions, which requires administrator rights, and exits non-zero otherwise.
 */

import { runCommand } from './exec.js';
import { psQuote, startHandover, type HandoverResult } from './handover.js';

let cached: boolean | null = null;

export async function isElevated(): Promise<boolean> {
  if (cached !== null) return cached;

  try {
    const result = await runCommand({
      file: 'net',
      args: ['session'],
      timeoutMs: 5000,
    });
    // Exit 0 means the enumeration succeeded, which only an elevated token permits.
    cached = result.code === 0;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * Relaunch elevated, sequenced so the two instances never coexist.
 *
 * The helper waits for THIS process to exit before starting the elevated copy. That removes the
 * single-instance race at the source rather than trying to win it: the new instance cannot fail to take
 * the lock, because nothing is holding it by the time the new instance exists.
 *
 * `Wait-Process` is the right primitive here. The obvious alternative — polling `process.kill(pid, 0)`
 * — is wrong: it goes through `OpenProcess`, which keeps succeeding for a process that has already
 * TERMINATED while any handle to it remains open, and the portable build's stub holds exactly such a
 * handle. That made the old process look permanently alive and the handoff always time out.
 *
 * Returns a report of whether the helper was launched, and by which mechanism. It cannot report
 * whether the user later accepted the elevation prompt, because by then this process is gone — a
 * deliberate trade for never racing. On a machine configured to prompt, the window closes and the
 * consent dialog follows; if it is declined, nothing reopens and the user relaunches normally.
 *
 * The helper is started through `handover.ts` rather than a plain detached spawn. That distinction is
 * not academic: a detached spawn works from the installed build and silently does not survive from the
 * PORTABLE one, which made "Restart as admin" a button that closed the window and did nothing at all —
 * on exactly the build most likely to be run from a USB stick by someone who cannot install software.
 */
export function relaunchElevated(
  exePath: string,
  workDir: string,
  args: string[] = [],
): HandoverResult {
  const start = [`Start-Process -FilePath ${psQuote(exePath)} -Verb RunAs`];
  if (args.length > 0) start.push(`-ArgumentList ${args.map(psQuote).join(',')}`);

  const script = [
    `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    start.join(' '),
  ].join('\n');

  return startHandover(script, workDir, 'elevate.ps1');
}

/**
 * Turn a failed upgrade into a message that names the actual cause.
 *
 * Permission failures are the single most common way an unelevated run fails, and every manager
 * phrases them differently. Recognising the phrasing lets the UI say "needs administrator" instead of
 * making the user read the transcript.
 */
export function looksLikePermissionFailure(text: string): boolean {
  return /access is denied|permission denied|requires? administrator|elevat(?:ed|ion)|EPERM|EACCES|not have (?:sufficient )?(?:permission|privilege)|run as administrator/i.test(
    text,
  );
}
