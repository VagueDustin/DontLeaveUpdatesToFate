/**
 * handover.ts — starting a process that outlives this one.
 *
 * Two features need it and both were broken by the same thing. "Restart as admin" and "install the
 * update" each work by leaving behind a helper that waits for this process to exit and then does
 * something to the files this process was using. On the INSTALLED build a plain detached `spawn` was
 * enough. On the PORTABLE build it silently was not: the app quit, the helper never ran, and there
 * was nothing anywhere to say why.
 *
 * THE LESSON IS NOT "USE MECHANISM X". Three mechanisms were tried against one real machine and two
 * of them failed in ways their own return values denied:
 *
 *  - `spawn` with `detached: true` reports a pid and exits cleanly. The portable build is a stub that
 *    extracts the app to a temp directory and tears it down afterwards, and a child created with
 *    `CreateProcess` does not survive that. `detached` governs the console and the process group; it
 *    does not confer independence.
 *  - `Win32_Process.Create` through WMI returns `0` and a process id, and on the machine this was
 *    found on that process is gone within a second having executed nothing at all. Not an ASR rule —
 *    none were configured — and the cause was never established. It did not need to be.
 *
 * So the design does not depend on picking the right one. It tries each in turn and REQUIRES PROOF:
 * the helper's first statement writes a marker file, and a mechanism only counts as having worked once
 * that file exists. "It reported success" is exactly the evidence that was misleading, so it is
 * exactly the evidence this refuses to accept.
 *
 * BE PRECISE ABOUT WHAT THE MARKER PROVES: that the helper reached its first line while we were still
 * alive. It cannot prove the helper will survive our exit, because observing that would require
 * outliving ourselves. That second property is what the ORDER is for — the mechanism least contained
 * by this process goes first. The marker is what caught the real failure, which was not a helper that
 * died late but one that never executed a single statement.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HandoverResult {
  started: boolean;
  /** Which mechanism proved itself, when one did. */
  method: string | null;
  /** Everything that was tried and what happened, as one line for the log. */
  detail: string;
}

/** Escape a string for embedding in a PowerShell single-quoted literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Longest wait for the helper to prove it is alive before moving to the next mechanism. */
const PROOF_TIMEOUT_MS = 2500;
const PROOF_POLL_MS = 100;

/** The interpreter invocation, as one command-line string. */
function helperArgs(scriptPath: string): string {
  return `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`;
}

/**
 * Block for `ms`.
 *
 * Deliberately synchronous. The caller's next act is to quit, so there is no event loop left to yield
 * to and nothing else that could usefully run — and doing this asynchronously would reintroduce the
 * window in which the app exits before the helper exists.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Some hosts refuse a blocking wait on the main thread. Burning a hundred milliseconds of CPU is
    // an ugly fallback, but silently not waiting would defeat the proof this exists to collect.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

function waitForProof(marker: string): boolean {
  for (let waited = 0; waited < PROOF_TIMEOUT_MS; waited += PROOF_POLL_MS) {
    if (existsSync(marker)) return true;
    sleepSync(PROOF_POLL_MS);
  }
  return existsSync(marker);
}

/**
 * PowerShell's `Start-Process`, from a short-lived process of our own.
 *
 * `Start-Process` goes through ShellExecute rather than CreateProcess, and the process it produces is
 * not contained the way a direct child is. The launcher itself is ours and dies with us, which is
 * fine — by then it has done its one job. Run synchronously so it cannot still be doing it when we go.
 */
function viaStartProcess(scriptPath: string): string {
  const command = `Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(
    helperArgs(scriptPath),
  )} -WindowStyle Hidden`;

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
  );

  if (result.error) return `error ${result.error.message}`;
  if (result.status !== 0) return `exit ${result.status} ${(result.stderr ?? '').trim().slice(0, 120)}`;
  return 'launched';
}

/** WMI, whose provider host owns the new process rather than us. */
function viaWmi(scriptPath: string): string {
  const command = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(
      `powershell.exe ${helperArgs(scriptPath)}`,
    )} }`,
    '  Write-Output ("rv={0}" -f $r.ReturnValue)',
    '} catch { Write-Output ("err={0}" -f $_.Exception.Message) }',
  ].join('\n');

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
  );

  if (result.error) return `error ${result.error.message}`;
  return (result.stdout ?? '').trim().split('\n').pop()?.trim() || 'no output';
}

/** The original approach. Last, because it is the one already known to fail on the portable build. */
function viaSpawn(scriptPath: string): string {
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      { windowsHide: true, stdio: 'ignore', detached: true },
    );
    child.on('error', () => {
      /* the chain judges by the marker, not by this */
    });
    child.unref();
    return `pid=${child.pid ?? '?'}`;
  } catch (error) {
    return `error ${error instanceof Error ? error.message : String(error)}`;
  }
}

const METHODS: Array<{ name: string; run: (scriptPath: string) => string }> = [
  { name: 'start-process', run: viaStartProcess },
  { name: 'wmi', run: viaWmi },
  { name: 'spawn', run: viaSpawn },
];

/**
 * Write `script` to a file and start it in a process that will outlive this one.
 *
 * The script is a file rather than an inline command because two of the three mechanisms take a
 * command LINE, and a base64-encoded PowerShell script runs to several kilobytes. A path is short.
 *
 * The marker line is prepended here rather than left to callers, so no caller can forget it and
 * accidentally opt out of the proof.
 */
export function startHandover(script: string, directory: string, name: string): HandoverResult {
  const marker = join(directory, `${name}.started`);
  let scriptPath: string;

  try {
    mkdirSync(directory, { recursive: true });
    rmSync(marker, { force: true });
    scriptPath = join(directory, name);

    const withProof = [
      `Set-Content -LiteralPath ${psQuote(marker)} -Value $PID -ErrorAction SilentlyContinue`,
      script,
      // Tidy up after itself; a stale helper script is only ever a way to run the wrong thing later.
      `Remove-Item -LiteralPath ${psQuote(marker)}, ${psQuote(scriptPath)} -Force -ErrorAction SilentlyContinue`,
    ].join('\n');

    // The BOM matters: PowerShell reads a plain .ps1 as the ANSI code page, which mangles non-ASCII
    // characters in a path — and this app installs under a folder containing an apostrophe.
    writeFileSync(scriptPath, `﻿${withProof}`, 'utf8');
  } catch (error) {
    return {
      started: false,
      method: null,
      detail: `could not write the helper script: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const attempts: string[] = [];
  for (const method of METHODS) {
    const said = method.run(scriptPath);
    if (waitForProof(marker)) {
      attempts.push(`${method.name}: ran`);
      return { started: true, method: method.name, detail: attempts.join('; ') };
    }
    attempts.push(`${method.name}: ${said} but never ran`);
  }

  return { started: false, method: null, detail: attempts.join('; ') };
}
