/**
 * logstore.test.ts: the markdown export's table escaping.
 *
 * The package table is the one part of an export built by string concatenation into a format with
 * its own syntax, so it is the one part that can be broken by the data it is describing. A cell that
 * ends early does not lose one value, every column after it shifts left, and a log exported to hand
 * to somebody else quietly says the wrong thing about where a package lives.
 */

import { describe, expect, it } from 'vitest';
import { __test } from '../src/main/logstore.js';

const { escapeCell } = __test;

/** What a markdown renderer does to a finished cell: `\X` is a literal X. */
function renderCell(cell: string): string {
  return cell.replace(/\\(.)/g, '$1');
}

describe('escapeCell', () => {
  it('escapes a bare pipe', () => {
    expect(escapeCell('a|b')).toBe('a\\|b');
  });

  /**
   * The bug this covers. `a\|b` escaped to `a\\|b`, where `\\` is a literal backslash and the pipe
   * that follows is bare, so the cell ended in the middle of the value.
   */
  it('escapes a pipe that already has a backslash in front of it', () => {
    const escaped = escapeCell('a\\|b');
    expect(escaped).toBe('a\\\\\\|b');
    expect(renderCell(escaped)).toBe('a\\|b');
  });

  it('handles a run of backslashes before a pipe', () => {
    const escaped = escapeCell('a\\\\|b');
    expect(renderCell(escaped)).toBe('a\\\\|b');
  });

  /**
   * The reason the fix is narrow. Locations are written inside a code span, where a backslash is
   * already literal, doubling them all would visibly corrupt every Windows path in every export.
   */
  it.each([
    'C:\\Program Files\\App',
    'C:\\Users\\dev\\AppData\\Roaming\\npm',
    'C:\\Program Files\\Sam, Inc\\app.exe',
  ])('leaves %j alone', (path) => {
    expect(escapeCell(path)).toBe(path);
  });

  it('leaves ordinary text alone', () => {
    expect(escapeCell('Updated 1.2.0 -> 1.2.1')).toBe('Updated 1.2.0 -> 1.2.1');
  });

  /** Whatever goes in, no cell may contain a pipe that is not escaped. */
  it.each([
    'a|b',
    'a\\|b',
    'a\\\\|b',
    '|',
    '||',
    '\\|\\|',
    'C:\\weird|path\\app.exe',
    'a\\\\\\|b',
  ])('never leaves an unescaped pipe in %j', (input) => {
    const escaped = escapeCell(input);
    // Walk the result: a pipe is only ever allowed when preceded by an odd number of backslashes.
    for (let i = 0; i < escaped.length; i += 1) {
      if (escaped[i] !== '|') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && escaped[j] === '\\'; j -= 1) slashes += 1;
      expect(slashes % 2).toBe(1);
    }
  });
});
