/**
 * logstore.ts — the session transcript.
 *
 * Two things make this more than an array:
 *
 *  1. BATCHING. A `choco upgrade` can emit hundreds of lines a second. One IPC message per line
 *     saturates the renderer and drops frames, so lines are buffered and flushed on a short timer.
 *     The flush interval is the single most important performance number in the app.
 *  2. A BOUNDED BUFFER. A long "update all" over 40 packages produces a lot of output. The buffer is
 *     capped and drops from the front, so memory cannot grow without limit during a long session —
 *     and the cap is high enough that a normal run is never truncated.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { EOL } from 'node:os';
import { join } from 'node:path';
import type { LogLevel, LogLine, LogExportFormat, ProviderId } from '../shared/types.js';
import { footerLine, PRODUCT_NAME } from '../shared/brand.js';

/** Lines kept in memory. At ~120 bytes a line this is a few megabytes at worst. */
const MAX_LINES = 50_000;

/** Flush cadence. 40ms is under one frame at 24fps and well above the cost of an IPC hop. */
const FLUSH_MS = 40;

/**
 * Longest single line kept intact.
 *
 * `pip list --format=json` emits its entire result as ONE line — 8KB for the 182 packages on this
 * machine. Storing that whole is wasteful, and rendering it in a `white-space: pre` row is worse.
 * Nothing informative lives past this many characters on one line.
 */
const MAX_LINE_LENGTH = 1000;

export interface LogContext {
  provider?: ProviderId | null;
  jobKey?: string | null;
}

export class LogStore {
  private lines: LogLine[] = [];
  private pending: LogLine[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private droppedCount = 0;
  private readonly startedAt = Date.now();
  private sink: WriteStream | null = null;
  private sinkPath: string | null = null;

  constructor(private readonly flush: (batch: LogLine[]) => void) {}

  /**
   * Start mirroring every line to a file, from the first line onwards.
   *
   * The in-memory buffer alone was a real gap: if the app is closed or crashes mid-run the entire
   * transcript is gone, and there is no way to inspect a run from outside the process at all. A 40-item
   * update run is exactly the situation where you most want the log afterwards.
   *
   * Appended synchronously-ish through a write stream so ordering is guaranteed; failures are
   * swallowed because logging must never be the thing that breaks a run.
   */
  openFile(dir: string, slug: string): string | null {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, suggestedLogName('txt', `${slug}-session`, new Date(this.startedAt)));
      this.sink = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
      this.sink.on('error', () => {
        this.sink = null;
      });
      this.sinkPath = path;
      this.sink.write(`${PRODUCT_NAME} — session log${EOL}${footerLine()}${EOL}${EOL}`);
      return path;
    } catch {
      this.sink = null;
      this.sinkPath = null;
      return null;
    }
  }

  get filePath(): string | null {
    return this.sinkPath;
  }

  /** Delete session logs older than `days`, so the directory cannot grow without bound. */
  static async prune(dir: string, days = 14): Promise<void> {
    const cutoff = Date.now() - days * 86_400_000;
    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.txt')) continue;
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) await unlink(path);
        } catch {
          /* leave it alone */
        }
      }
    } catch {
      /* no directory yet */
    }
  }

  append(text: string, level: LogLevel, context: LogContext = {}): LogLine {
    const line: LogLine = {
      seq: this.seq++,
      ts: Date.now(),
      level,
      text:
        text.length > MAX_LINE_LENGTH
          ? `${text.slice(0, MAX_LINE_LENGTH)}… [${text.length - MAX_LINE_LENGTH} more characters]`
          : text,
      provider: context.provider ?? null,
      jobKey: context.jobKey ?? null,
    };

    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.droppedCount += this.lines.length - MAX_LINES;
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }

    if (this.sink) {
      try {
        this.sink.write(`${stamp(line.ts)}  ${LEVEL_TAG[line.level]}  ${line.text}${EOL}`);
      } catch {
        /* a failed write must not break the run */
      }
    }

    this.pending.push(line);
    this.schedule();
    return line;
  }

  /** Emit a visual separator with a title — used to head each provider scan and each upgrade. */
  rule(title: string, context: LogContext = {}): void {
    this.append(title, 'system', context);
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, FLUSH_MS);
  }

  /** Send anything buffered immediately. Called before a run ends so the tail is never withheld. */
  drain(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.flush(batch);
  }

  snapshot(): LogLine[] {
    return this.lines;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.lines = [];
    this.pending = [];
    this.droppedCount = 0;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.sink?.end();
    } catch {
      /* shutting down anyway */
    }
    this.sink = null;
  }

  /** Render the transcript for export. */
  export(format: LogExportFormat, meta: ExportMeta): string {
    switch (format) {
      case 'json':
        return exportJson(this.lines, meta, this.droppedCount);
      case 'md':
        return exportMarkdown(this.lines, meta, this.droppedCount);
      case 'txt':
      default:
        return exportText(this.lines, meta, this.droppedCount);
    }
  }

  get sessionStartedAt(): number {
    return this.startedAt;
  }
}

export interface ExportMeta {
  appVersion: string;
  electronVersion: string;
  osVersion: string;
  elevated: boolean;
  /** Provider label → version, for the header block. */
  providers: Array<{ label: string; version: string | null; available: boolean }>;
  /**
   * Every package the run touched, or the scan found — with where it lives on disk.
   *
   * The transcript alone answers "what happened"; this answers "to what, and where". Reading a
   * 1200-line transcript to work out which four of seventy-four packages failed, and where on the
   * machine they are, is work the export can do once.
   */
  packages: ExportPackage[];
  updated: number;
  failed: number;
  skipped: number;
}

export interface ExportPackage {
  name: string;
  id: string;
  provider: string;
  from: string;
  to: string;
  location: string | null;
  /** Job status when this package was part of a run, otherwise null. */
  status: string | null;
  detail: string | null;
}

/**
 * A timestamp in the machine's own time zone, with the offset spelled out.
 *
 * It used to be `toISOString()`, which is UTC — so an export made at 21:03 local was named
 * `…-log-20260822-210349.md` (local, from `suggestedLogName`) and opened with
 * `Exported | 2026-08-23 04:03:52` (UTC) two lines in. The same instant, two clocks, one file, and
 * neither of them the one on the wall behind the screen. The terminal pane has always shown local
 * time, so local is what the export matches.
 */
function stamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** `UTC+01:00` — named once in the export header so the stamps above are unambiguous. */
function timeZoneLabel(now = new Date()): string {
  // getTimezoneOffset is minutes WEST of UTC, so the sign is inverted from how anyone writes it.
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * A pipe inside a markdown table cell ends the cell; ids and paths can both contain one.
 *
 * Any backslashes immediately in front of that pipe have to be doubled at the same time, or the
 * escape lands on the wrong character: `a\|b` used to come out as `a\\|b`, which reads as a literal
 * backslash followed by a pipe that still ends the cell — one broken row, and every column after it
 * shifted left.
 *
 * ONLY the run touching the pipe is doubled, which is the whole point. Escaping every backslash is
 * the textbook answer and is the wrong answer here: `location` is written inside a code span, where
 * a backslash is already literal, so a blanket escape would make `C:\Program Files` start rendering
 * as `C:\\Program Files` in every exported log to fix a row nobody has ever hit.
 */
function escapeCell(text: string): string {
  return text.replace(/(\\*)\|/g, (_, slashes: string) => `${slashes}${slashes}\\|`);
}

const LEVEL_TAG: Record<LogLevel, string> = {
  system: '··',
  command: '$ ',
  stdout: '  ',
  stderr: '! ',
  success: 'ok',
  warn: ' !',
  error: 'xx',
};

function headerLines(meta: ExportMeta, dropped: number): string[] {
  const out = [
    `${PRODUCT_NAME} — update log`,
    footerLine(),
    '',
    `Exported     ${stamp(Date.now())} (${timeZoneLabel()})`,
    `App version  ${meta.appVersion}`,
    `Electron     ${meta.electronVersion}`,
    `Windows      ${meta.osVersion}`,
    `Elevated     ${meta.elevated ? 'yes' : 'no'}`,
    `Result       ${meta.updated} updated · ${meta.failed} failed · ${meta.skipped} skipped`,
    '',
    'Package managers',
  ];
  for (const p of meta.providers) {
    const state = p.available ? (p.version ?? 'present') : 'not available';
    out.push(`  ${p.label.padEnd(26)} ${state}`);
  }
  if (dropped > 0) {
    out.push('', `NOTE: ${dropped} earlier line(s) were dropped from the in-memory buffer.`);
  }
  out.push('');
  return out;
}

function exportText(lines: LogLine[], meta: ExportMeta, dropped: number): string {
  const out = headerLines(meta, dropped);

  if (meta.packages.length > 0) {
    out.push('Packages', '');
    for (const pkg of meta.packages) {
      out.push(
        `  ${pkg.name} (${pkg.provider})`,
        `      ${pkg.from} → ${pkg.to}${pkg.status ? `   [${pkg.status}]` : ''}`,
        `      ${pkg.location ?? 'location unknown'}`,
      );
      if (pkg.detail) out.push(`      ${pkg.detail}`);
    }
    out.push('');
  }

  out.push('─'.repeat(78), '');
  for (const line of lines) {
    out.push(`${stamp(line.ts)}  ${LEVEL_TAG[line.level]}  ${line.text}`);
  }
  out.push('');
  return out.join(EOL);
}

function exportMarkdown(lines: LogLine[], meta: ExportMeta, dropped: number): string {
  const out: string[] = [
    `# ${PRODUCT_NAME} — update log`,
    '',
    `> ${footerLine()}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Exported | ${stamp(Date.now())} (${timeZoneLabel()}) |`,
    `| App version | ${meta.appVersion} |`,
    `| Electron | ${meta.electronVersion} |`,
    `| Windows | ${meta.osVersion} |`,
    `| Elevated | ${meta.elevated ? 'yes' : 'no'} |`,
    `| Result | ${meta.updated} updated · ${meta.failed} failed · ${meta.skipped} skipped |`,
    '',
    '## Package managers',
    '',
    '| Manager | Version |',
    '| --- | --- |',
  ];
  for (const p of meta.providers) {
    out.push(`| ${p.label} | ${p.available ? (p.version ?? 'present') : '_not available_'} |`);
  }
  if (dropped > 0) {
    out.push('', `> ${dropped} earlier line(s) were dropped from the in-memory buffer.`);
  }

  if (meta.packages.length > 0) {
    out.push(
      '',
      '## Packages',
      '',
      '| Package | Manager | From | To | Result | Location |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const pkg of meta.packages) {
      const result = pkg.status ? (pkg.detail ? `${pkg.status} — ${pkg.detail}` : pkg.status) : '—';
      out.push(
        `| ${escapeCell(pkg.name)} | ${pkg.provider} | \`${pkg.from}\` | \`${pkg.to}\` | ` +
          `${escapeCell(result)} | ${pkg.location ? `\`${escapeCell(pkg.location)}\`` : '_unknown_'} |`,
      );
    }
  }

  out.push('', '## Transcript', '', '```text');
  for (const line of lines) {
    out.push(`${stamp(line.ts)}  ${LEVEL_TAG[line.level]}  ${line.text}`);
  }
  out.push('```', '');
  return out.join(EOL);
}

function exportJson(lines: LogLine[], meta: ExportMeta, dropped: number): string {
  return `${JSON.stringify(
    {
      product: PRODUCT_NAME,
      credit: footerLine(),
      exportedAt: new Date().toISOString(),
      exportedAtLocal: `${stamp(Date.now())} (${timeZoneLabel()})`,
      environment: {
        appVersion: meta.appVersion,
        electronVersion: meta.electronVersion,
        osVersion: meta.osVersion,
        elevated: meta.elevated,
      },
      result: { updated: meta.updated, failed: meta.failed, skipped: meta.skipped },
      providers: meta.providers,
      packages: meta.packages,
      droppedLines: dropped,
      lines: lines.map((l) => ({
        seq: l.seq,
        at: new Date(l.ts).toISOString(),
        atLocal: stamp(l.ts),
        level: l.level,
        provider: l.provider,
        jobKey: l.jobKey,
        text: l.text,
      })),
    },
    null,
    2,
  )}${EOL}`;
}

/** Suggested filename, e.g. `DontLeaveUpdatesToFate-log-20260801-143012.txt`. */
export function suggestedLogName(format: LogExportFormat, slug: string, now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${slug}-log-${date}-${time}.${format}`;
}

/** Exported so a test can prove the markdown export cannot be made to break its own table. */
export const __test = { escapeCell };
