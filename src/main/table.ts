/**
 * table.ts — parser for the fixed-width tables that Windows CLIs print.
 *
 * winget, `scoop status` and `cargo install-update --list` all render aligned columns. Two naive
 * approaches both fail on real output from this machine:
 *
 *   Splitting on runs of 2+ spaces  →  breaks on
 *     "FFmpeg for yt-dlp  yt-dlp.FFmpeg  N-124279-g0f6ba39122-20260430 N-125365-g9a01c1cb6a-20260630"
 *     where a value fills its column exactly and only ONE space separates it from the next.
 *
 *   Splitting on single spaces      →  breaks on
 *     "Ubisoft Connect  Ubisoft.Connect  < 172.1.0.13247  172.1.0.13247"
 *     where both the name and the version legitimately contain a space.
 *
 * So columns are located once from the header row and every data row is sliced at those offsets.
 * The offsets are *display* columns, not string indices: a CJK package name occupies two terminal
 * cells per character, and slicing such a row by `String.prototype.slice` shifts every later field.
 */

/**
 * Terminal display width of a single code point.
 *
 * Combining marks take no cell; East Asian Wide/Fullwidth characters and emoji take two. Anything
 * else takes one. This is the subset of UAX #11 that actually shows up in package names.
 */
export function charWidth(codePoint: number): number {
  // Combining marks and zero-width characters.
  if (
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }

  // East Asian Wide / Fullwidth, and the emoji planes.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/**
 * Convert a display column to a string index.
 *
 * When the column lands in the middle of a wide character, the index of that character is returned —
 * so a slice starting there includes the whole glyph rather than half of it.
 */
function indexAtColumn(line: string, column: number): number {
  if (column <= 0) return 0;
  let width = 0;
  let index = 0;
  for (const ch of line) {
    if (width >= column) return index;
    width += charWidth(ch.codePointAt(0)!);
    index += ch.length;
  }
  return line.length;
}

export interface TableSchema {
  /** Header labels in order, with the display column each starts at. */
  columns: Array<{ label: string; start: number }>;
}

/**
 * Locate the columns of a header row, given the labels expected in it.
 *
 * Labels are found left-to-right so that a label which is also a substring of an earlier one (for
 * example "Version" inside "Installed Version") cannot match the wrong occurrence.
 */
export function readHeader(header: string, labels: string[]): TableSchema | null {
  const columns: Array<{ label: string; start: number }> = [];
  let cursor = 0;

  for (const label of labels) {
    const at = header.indexOf(label, cursor);
    if (at === -1) return null;
    columns.push({ label, start: displayWidth(header.slice(0, at)) });
    cursor = at + label.length;
  }
  return { columns };
}

/** Slice one data row into trimmed cells using a schema from `readHeader`. */
export function sliceRow(row: string, schema: TableSchema): string[] {
  const cells: string[] = [];
  const { columns } = schema;

  for (let i = 0; i < columns.length; i++) {
    const from = indexAtColumn(row, columns[i]!.start);
    const next = columns[i + 1];
    const to = next === undefined ? row.length : indexAtColumn(row, next.start);
    cells.push(row.slice(from, to).trim());
  }
  return cells;
}

/**
 * A row of dashes / box-drawing characters that separates the header from the body.
 *
 * Internal whitespace is allowed because the two producers differ: winget draws one continuous run
 * of dashes, while PowerShell's `Format-Table` (which is what `scoop status` prints through) draws
 * one dash group per column — `----  ---------------  --------------`.
 */
export function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  // Must be made only of rule characters and spaces, and contain at least one rule character.
  return /^[-=_─-╿\s]+$/.test(trimmed) && /[-=_─-╿]/.test(trimmed);
}

export interface ParsedTable {
  schema: TableSchema;
  rows: string[][];
}

export interface ParseTableOptions {
  /** Header labels, in order. A line containing all of them starts a table. */
  labels: string[];
  /** Return false to end the current table at this line (it is not treated as a row). */
  isEnd?: (line: string) => boolean;
}

/**
 * Parse every fixed-width table in a block of output.
 *
 * Returns a list because `winget upgrade` prints two: the main list, then a second one under
 * "The following packages have an upgrade available, but require explicit targeting for upgrade",
 * each with its own header row.
 */
export function parseTables(lines: string[], options: ParseTableOptions): ParsedTable[] {
  const tables: ParsedTable[] = [];
  let current: ParsedTable | null = null;

  for (const line of lines) {
    const header = readHeader(line, options.labels);
    if (header) {
      current = { schema: header, rows: [] };
      tables.push(current);
      continue;
    }

    if (!current) continue;
    if (isSeparatorRow(line)) continue;

    if (line.trim().length === 0 || options.isEnd?.(line)) {
      current = null;
      continue;
    }

    current.rows.push(sliceRow(line, current.schema));
  }

  return tables.filter((t) => t.rows.length > 0);
}
