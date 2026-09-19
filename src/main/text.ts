/**
 * text.ts: pure text cleaning for console output.
 *
 * Split out from `exec.ts` so it can be unit-tested without spawning anything, and written with
 * regex *literals* rather than `new RegExp(string)`: the string form needs every backslash doubled,
 * and getting that wrong silently changes the pattern (or throws at module load).
 */

/**
 * ANSI escape sequences: OSC (`ESC ] … BEL`/ST), CSI, and the two-character forms.
 *
 * `\x1B` is ESC, `\x9B` is the single-byte CSI some tools emit.
 */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /[\x1B\x9B]\][^\x07\x1B]*(?:\x07|\x1B\\)?|[\x1B\x9B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\x1B[@-Z\\-_]/g;

/** Control bytes that spinners and progress bars leave behind once the escapes are gone. */
// eslint-disable-next-line no-control-regex
const CONTROL_LEFTOVERS = /[\x00\x07\x08\x0B\x0C]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL_LEFTOVERS, '');
}

/**
 * Collapse a carriage-return progress rewrite to its final state.
 *
 * `"  0%\r 50%\r100%"` is one physical line that a terminal would end up showing as `"100%"`.
 * Keeping every intermediate frame would flood the log pane with thousands of junk lines.
 */
export function collapseCarriageReturns(line: string): string {
  // A single trailing CR is the second half of a CRLF line ending, not a rewrite. Without this the
  // "last frame" is the empty string after it, and every line of CRLF output comes back blank.
  const body = line.endsWith('\r') ? line.slice(0, -1) : line;
  const idx = body.lastIndexOf('\r');
  return idx === -1 ? body : body.slice(idx + 1);
}

/**
 * Progress bars, spinners, box-drawing rules and separator lines carry no information once a run is
 * over. Ranges cover the block elements (U+2580–U+259F), box drawing (U+2500–U+257F) and geometric
 * shapes (U+25A0–U+25FF) that winget, choco and scoop all draw with.
 */
const NOISE_ONLY = /^[\s─-◿·.\-_=|/\\+*#•∙]*$/;

export function isNoiseLine(line: string): boolean {
  if (line.length === 0) return true;
  if (NOISE_ONLY.test(line)) return true;
  // Percentage-only progress frames.
  if (/^\s*\d{1,3}%\s*$/.test(line)) return true;
  // Byte-counter frames, e.g. "  12.4 MB / 58.1 MB".
  if (/^\s*[\d.]+\s*[KMGT]?B\s*\/\s*[\d.]+\s*[KMGT]?B\s*$/i.test(line)) return true;
  // Chocolatey retry chatter, which it prints even when the command ultimately succeeds.
  if (/^\s*This is try \d+\/\d+\./.test(line)) return true;
  return false;
}

/** Clean one raw physical line: collapse progress rewrites, strip escapes, trim trailing space. */
export function cleanLine(raw: string): string {
  return stripAnsi(collapseCarriageReturns(raw)).replace(/\s+$/, '');
}

/**
 * Decide how to colour a line that arrived on stderr.
 *
 * "stderr" does not mean "error" for command-line tools, plenty use it for all diagnostics. rustup
 * writes its entire normal progress there (`info: downloading 7 components`,
 * `info: removing previous version of component cargo`), and painting all of it red made a completely
 * healthy toolchain update look like a catastrophe.
 *
 * So the stream picks the default and the CONTENT overrides it.
 */
export function classifyStderr(line: string): 'stdout' | 'warn' | 'stderr' {
  const text = line.trim();
  if (text.length === 0) return 'stdout';

  // Explicitly informational prefixes used by rustup, cargo, pip, git and npm.
  if (/^(?:info|note|notice|debug|verbose|added|updated|downloading|installing|collecting)\b[: ]/i.test(text)) {
    return 'stdout';
  }
  if (/^(?:warn|warning|deprecat)/i.test(text)) return 'warn';
  // Genuine error vocabulary.
  if (/\b(?:error|fatal|failed|failure|denied|cannot|unable|exception|traceback)\b/i.test(text)) {
    return 'stderr';
  }
  // Anything else on stderr is most likely progress chatter, not a problem.
  return 'stdout';
}

/** Turn a raw multi-line fragment into clean, terminal-accurate lines (noise included). */
export function normaliseChunk(text: string): string[] {
  return text.split('\n').map(cleanLine);
}

/**
 * Extract the first complete JSON value from output that has extra text around it.
 *
 * `pip list --outdated --format=json` prints its array and then appends a human-readable
 * `[notice] A new release of pip is available` block, so `JSON.parse` on the whole stream fails.
 * Scans for the first `{` or `[` and walks to its match, respecting strings and escapes.
 */
export function extractFirstJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse JSON that may be surrounded by non-JSON chatter. Returns null rather than throwing. */
export function parseLooseJson<T>(text: string): T | null {
  const slice = extractFirstJson(text);
  if (slice === null) return null;
  try {
    return JSON.parse(slice) as T;
  } catch {
    return null;
  }
}

/**
 * Compare two version strings well enough to decide "is B actually newer than A".
 *
 * Not semver: these strings come from winget, choco, pip, cargo and rustup, and include things like
 * `N-125365-g9a01c1cb6a-20260630`, `7.1.2.2400`, `< 172.1.0.13247` and `Unknown`. Numeric runs are
 * compared numerically, everything else lexically, and a missing segment counts as zero so that
 * `1.2` < `1.2.1`.
 *
 * Returns a negative number when `a` is older, 0 when equivalent, positive when `a` is newer, and
 * `null` when either side is not comparable at all.
 */
export function compareVersions(a: string, b: string): number | null {
  const na = normaliseVersion(a);
  const nb = normaliseVersion(b);
  if (na === null || nb === null) return null;

  const pa = tokeniseVersion(na);
  const pb = tokeniseVersion(nb);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const ta = pa[i];
    const tb = pb[i];
    if (ta === undefined) return tb === undefined ? 0 : typeof tb === 'number' && tb === 0 ? 0 : -1;
    if (tb === undefined) return typeof ta === 'number' && ta === 0 ? 0 : 1;
    if (typeof ta === 'number' && typeof tb === 'number') {
      if (ta !== tb) return ta < tb ? -1 : 1;
    } else {
      const sa = String(ta);
      const sb = String(tb);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Strip the decorations managers add, or return null when there is no version to read. */
function normaliseVersion(raw: string): string | null {
  const v = raw.trim().replace(/^[<>=~^v]+\s*/i, '').trim();
  if (v.length === 0) return null;
  if (/^unknown$/i.test(v)) return null;
  return v;
}

function tokeniseVersion(v: string): Array<number | string> {
  const parts = v.split(/[.\-+_]/).filter((p) => p.length > 0);
  const out: Array<number | string> = [];
  for (const part of parts) {
    // Split mixed runs like "2400a" or "rc1" into comparable pieces.
    const runs = part.match(/\d+|[^\d]+/g) ?? [part];
    for (const run of runs) {
      out.push(/^\d+$/.test(run) ? Number.parseInt(run, 10) : run.toLowerCase());
    }
  }
  return out;
}

/**
 * True when `available` is a genuine upgrade over `current`.
 *
 * Managers occasionally list a package whose "available" version is equal to or older than what is
 * installed (choco does this for pinned side-by-side installs). Filtering those out is what keeps
 * the count in the header honest. When the comparison is impossible, trust the manager and say yes.
 */
export function isRealUpgrade(current: string, available: string): boolean {
  const cmp = compareVersions(current, available);
  if (cmp === null) return true;
  return cmp < 0;
}
