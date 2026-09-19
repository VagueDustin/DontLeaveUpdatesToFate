/**
 * exec.ts: the one place this app starts a process.
 *
 * Everything a provider wants to run goes through `runCommand`. That concentrates four problems
 * that are each easy to get subtly wrong on Windows:
 *
 *  1. INJECTION. No `shell: true`, ever. Arguments are validated against a deny-list of shell
 *     metacharacters before a command line is assembled, so there is nothing left to inject with.
 *  2. `.cmd` SHIMS. `npm`, `pnpm` and `scoop` are batch shims. Since the fix for CVE-2024-27980,
 *     Node refuses to spawn `.cmd`/`.bat` without a shell, so those go through `cmd.exe /d /s /c`
 *     with `windowsVerbatimArguments` and quoting we control.
 *  3. ENCODING. Console tools emit UTF-8, UTF-8-with-BOM or UTF-16LE depending on the tool and on
 *     whether output is redirected. A wrong guess produces mojibake or NUL-riddled text, so the
 *     first chunk is sniffed and the rest is decoded as a stream.
 *  4. PROGRESS REWRITES. winget and choco animate with `\r` and ANSI. See `text.ts`.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
// Imported explicitly rather than relying on the global: the main process compiles without the DOM
// lib, so the global `TextDecoder` exists as a value but has no type.
import { TextDecoder } from 'node:util';
import { cleanLine, isNoiseLine } from './text.js';

/** Thrown when an argument contains something that could break out of the command line. */
export class UnsafeArgumentError extends Error {
  constructor(public readonly argument: string) {
    super(`Refusing to run a command with an unsafe argument: ${JSON.stringify(argument)}`);
    this.name = 'UnsafeArgumentError';
  }
}

/**
 * Characters that can change the meaning of a `cmd.exe` command line, plus the control characters
 * that could smuggle a second command in.
 *
 * Whitespace is on the list because no argument this app builds needs it: flags are fixed strings
 * and package ids come from `isSafePackageId`. The one value that legitimately contains spaces is an
 * interpreter path (`C:\Program Files\...\python.exe`), and that is always passed as `file`, where
 * Node: or `quoteForCmd` on the `.cmd` path, does the quoting.
 */
const FORBIDDEN_IN_ARG = /["'`&|<>^%!()\s;,]/;

export function assertSafeArg(arg: string): void {
  if (arg.length === 0 || FORBIDDEN_IN_ARG.test(arg)) throw new UnsafeArgumentError(arg);
}

/**
 * Validate a package identifier that came out of parsed CLI output before it goes back into a CLI.
 *
 * Every id this app passes to an upgrade command has been through here first. The allowed set is the
 * union of what winget (`Publisher.Product`), npm (`@scope/name`), pip (`pkg-name`), choco
 * (`pkg.extension`) and cargo actually use.
 */
export function isSafePackageId(id: string): boolean {
  return id.length > 0 && id.length <= 214 && /^[A-Za-z0-9@][A-Za-z0-9._+@/-]*$/.test(id);
}

// ── binary resolution ─────────────────────────────────────────────────────────────────────────

const resolveCache = new Map<string, string | null>();

/**
 * Locate a command on PATH the way the shell would, without spawning `where.exe`.
 *
 * Done by hand because it runs once per provider at startup, and a subprocess each would add
 * ~40ms × 8 providers to first paint. Results are cached for the process lifetime.
 */
export async function resolveBinary(command: string): Promise<string | null> {
  const cached = resolveCache.get(command);
  if (cached !== undefined) return cached;
  const found = await resolveBinaryUncached(command);
  resolveCache.set(command, found);
  return found;
}

async function resolveBinaryUncached(command: string): Promise<string | null> {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  const hasExt = extname(command) !== '';

  if (isAbsolute(command)) {
    candidates.push(command);
    if (!hasExt) for (const ext of exts) candidates.push(command + ext);
  } else {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      // PATH entries are frequently quoted and occasionally have a trailing separator.
      const clean = dir.replace(/^"|"$/g, '').trim();
      if (!clean) continue;
      const base = join(clean, command);
      if (hasExt) candidates.push(base);
      else for (const ext of exts) candidates.push(base + ext);
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, FS.F_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ── output decoding ───────────────────────────────────────────────────────────────────────────

/**
 * Streaming decoder that picks its encoding from the first bytes it sees.
 *
 * UTF-16LE with no BOM is the case that matters: some Windows tools switch to it when output is
 * redirected, and decoding that as UTF-8 yields text with a NUL between every character. The tell is
 * that ASCII text in UTF-16LE has a zero byte at every odd offset.
 */
export class StreamDecoder {
  private decoder: TextDecoder | null = null;
  private sniffed = false;

  write(chunk: Buffer): string {
    if (!this.sniffed) {
      this.sniffed = true;
      const { encoding, skip } = sniffEncoding(chunk);
      this.decoder = new TextDecoder(encoding, { fatal: false });
      if (skip > 0) chunk = chunk.subarray(skip);
    }
    return this.decoder!.decode(chunk, { stream: true });
  }

  /** Flush any partial multi-byte sequence still held by the decoder. */
  end(): string {
    if (!this.decoder) return '';
    return this.decoder.decode(new Uint8Array(0), { stream: false });
  }
}

export function sniffEncoding(buf: Buffer): { encoding: string; skip: number } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', skip: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', skip: 2 };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', skip: 2 };
  }

  // No BOM: look for the UTF-16LE signature in the first 128 bytes.
  const sample = Math.min(buf.length, 128);
  if (sample >= 4) {
    let oddZeros = 0;
    let oddTotal = 0;
    for (let i = 1; i < sample; i += 2) {
      oddTotal++;
      if (buf[i] === 0x00) oddZeros++;
    }
    if (oddTotal >= 2 && oddZeros / oddTotal > 0.6) return { encoding: 'utf-16le', skip: 0 };
  }
  return { encoding: 'utf-8', skip: 0 };
}

// ── running ───────────────────────────────────────────────────────────────────────────────────

export type StreamName = 'stdout' | 'stderr';

export interface RunOptions {
  /** Absolute path to the executable, as returned by `resolveBinary`. */
  file: string;
  args: string[];
  /** Milliseconds before the process tree is killed. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for every clean, non-noise line as it arrives. */
  onLine?: (line: string, stream: StreamName) => void;
  cwd?: string;
  /** Extra environment on top of the inherited one. */
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Text to write to the child's stdin, which is then closed.
   *
   * This is how a helper SCRIPT is handed to an interpreter without going near the argument
   * validator: `python -` and `node -` both read a program from stdin, so the whole program travels
   * out-of-band instead of being squeezed through a command line that (correctly) refuses spaces and
   * quotes. Without it the only options are `-c "…"`, which needs the very characters
   * `assertSafeArg` exists to reject, or a temp file, whose path breaks on a username with a space.
   */
  input?: string;
}

export interface CommandResult {
  /** Exit code, or null when the process was killed or failed to start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Clean lines from both streams, in arrival order. */
  lines: string[];
  timedOut: boolean;
  cancelled: boolean;
  /** True when the executable could not be started at all. */
  spawnFailed: boolean;
  durationMs: number;
  /** The command line as a human would type it, for the log header. */
  display: string;
}

/** Quote for a `cmd.exe /c` verbatim command line. Safe because `"` can never appear in an arg. */
function quoteForCmd(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part;
}

/**
 * Build the single argument that follows `cmd.exe /d /s /c`.
 *
 * `cmd /s /c` strips the first and the last quote character of everything after `/c` and runs the
 * rest verbatim. So passing `"C:\Program Files\nodejs\npm.cmd" --version` gets those two quotes
 * removed, leaving an unquoted path with a space in it, cmd then tries to run `C:\Program`. Wrapping
 * the whole command line in one MORE pair of quotes is what makes `/s` strip the right ones.
 *
 * Verified against `npm.cmd --version` on this machine: unwrapped exits 1 with
 * "'C:\Program' is not recognized"; wrapped prints the version.
 */
function cmdCommandLine(file: string, args: string[]): string {
  return `"${[quoteForCmd(file), ...args.map(quoteForCmd)].join(' ')}"`;
}

export function displayCommand(file: string, args: string[]): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return [base, ...args].map(quoteForCmd).join(' ');
}

/**
 * Environment applied to every child: no colour, no progress animation, no interactive prompts.
 *
 * Without these, `npm` writes a spinner, `pip` writes upgrade notices with ANSI colour, and `winget`
 * can block forever waiting for an agreement prompt that nobody can see.
 */
function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    TERM: 'dumb',
    npm_config_color: 'false',
    npm_config_progress: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    WINGET_DISABLE_INTERACTIVITY: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    ...extra,
  };
}

export async function runCommand(options: RunOptions): Promise<CommandResult> {
  const { file, args, timeoutMs, signal, onLine, cwd, input } = options;

  for (const arg of args) assertSafeArg(arg);

  const startedAt = Date.now();
  const display = displayCommand(file, args);

  const abortedResult = (): CommandResult => ({
    code: null,
    stdout: '',
    stderr: '',
    lines: [],
    timedOut: false,
    cancelled: true,
    spawnFailed: false,
    durationMs: Date.now() - startedAt,
    display,
  });

  if (signal?.aborted) return abortedResult();

  const ext = extname(file).toLowerCase();
  const viaCmd = ext === '.cmd' || ext === '.bat';
  const env = childEnv(options.extraEnv);

  const stdin: 'ignore' | 'pipe' = input === undefined ? 'ignore' : 'pipe';

  const child = viaCmd
    ? spawn('cmd.exe', ['/d', '/s', '/c', cmdCommandLine(file, args)], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: [stdin, 'pipe', 'pipe'],
        cwd,
        env,
      })
    : spawn(file, args, {
        windowsHide: true,
        stdio: [stdin, 'pipe', 'pipe'],
        cwd,
        env,
      });

  if (input !== undefined && child.stdin) {
    // A child that exits before reading raises EPIPE on this write; that is a normal outcome, not an
    // error worth surfacing, so it is swallowed and the exit code speaks for the run.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input, 'utf8');
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const lines: string[] = [];

  let timedOut = false;
  let cancelled = false;
  let settled = false;

  /** Incremental line splitter: buffers a partial trailing line until the next chunk completes it. */
  const attach = (
    stream: NodeJS.ReadableStream | null,
    name: StreamName,
    sink: string[],
  ): void => {
    if (!stream) return;
    const decoder = new StreamDecoder();
    let pending = '';

    const emit = (raw: string): void => {
      const line = cleanLine(raw);
      if (isNoiseLine(line)) return;
      lines.push(line);
      onLine?.(line, name);
    };

    stream.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (!text) return;
      sink.push(text);
      pending += text;
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) emit(part);
    });

    stream.on('end', () => {
      const rest = decoder.end();
      if (rest) sink.push(rest);
      const leftover = pending + rest;
      pending = '';
      if (leftover.length > 0) emit(leftover);
    });

    stream.on('error', () => {
      /* the close handler reports the outcome */
    });
  };

  attach(child.stdout, 'stdout', stdoutChunks);
  attach(child.stderr, 'stderr', stderrChunks);

  const stop = (): void => {
    if (settled) return;
    killTree(child.pid);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);

  const onAbort = (): void => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let spawnFailed = false;

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = true;
      const message =
        err.code === 'ENOENT'
          ? `${file} is no longer on this system.`
          : `Failed to start ${file}: ${err.message}`;
      stderrChunks.push(`${message}\n`);
      lines.push(message);
      onLine?.(message, 'stderr');
      resolve(null);
    });
    child.on('close', (exitCode) => {
      if (spawnFailed) return;
      resolve(exitCode);
    });
  });

  settled = true;
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);

  return {
    code,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    lines,
    timedOut,
    cancelled,
    spawnFailed,
    durationMs: Date.now() - startedAt,
    display,
  };
}

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` on Windows only signals the immediate child, which leaves winget's installer
 * subprocess and choco's embedded PowerShell running after a cancel. `taskkill /T` walks the tree.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => {
      /* nothing left to do */
    });
  } catch {
    /* nothing left to do */
  }
}
