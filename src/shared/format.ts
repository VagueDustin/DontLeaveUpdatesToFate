/**
 * format.ts: presentation helpers that both sides of the app need.
 *
 * Pure string work only: no `electron`, no `node:*`, no DOM. Lives in `shared` rather than in the
 * renderer so it can be unit-tested in a plain Node environment, and so the log export can format a
 * path the same way the table does.
 */

/**
 * Fallback budget, used only before the column has been measured.
 *
 * The real number comes from the caller: the location column is `fr`-sized, so it is 13 characters
 * wide at the smallest supported window and more than thirty at 1920. A constant guess is wrong at
 * one end or the other, and being wrong low throws away context that would have fitted.
 */
const PATH_BUDGET = 14;

/**
 * A path shortened from the LEFT, keeping as much of the tail as will fit.
 *
 * `C:\Users\dev\AppData\Local\Programs\Python\Python310\lib\site-packages\torch` is 78 characters
 * in a column about twenty wide, and every character identifying WHICH package this is lives at the
 * end. A plain right-side ellipsis renders the same useless `C:\Users\dev\AppData\Loc…` on every
 * row, so the front is replaced with a marker: `…\site-packages\torch`.
 *
 * One parent segment is kept when it fits, because `site-packages\torch` says more than `torch` and
 * `lib\ffmpeg` more than `ffmpeg`. When it does not fit, the parent goes rather than the leaf,
 * `C:\Program Files\obs-studio` becomes `…\obs-studio`, not `C:\Program F…`. Losing the front is a
 * choice; losing the end is just an overflow.
 *
 * Two approaches were tried first and are not coming back. Rendering the dropped prefix as real,
 * shrinking text produced `C:\… lib\ffmpeg` and `C. Docker\Docker`, a truncated prefix reads as a
 * typo. And CSS `direction: rtl`, the usual trick for left-side ellipsis, reverses the bidi ordering
 * of the leading separator and lands it at the wrong end of the string.
 */
export function compactPath(path: string, budget = PATH_BUDGET): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length <= 1) return path;

  for (const keep of [1, 0]) {
    const tail = parts.slice(-(keep + 1));
    if (tail.length === parts.length) return parts.join('\\');

    // Eliding a bare drive letter costs two characters to save three. Keep it: `C:\Program Files\Git`
    // is both shorter and more informative than `…\Program Files\Git`.
    const dropped = parts.length - tail.length;
    const whole = dropped === 1 && parts[0]!.length <= 2 ? parts.join('\\') : null;

    const candidate = whole ?? `…\\${tail.join('\\')}`;
    if (candidate.length <= budget || keep === 0) return candidate;
  }

  // Unreachable: the keep === 0 pass always returns.
  return path;
}
