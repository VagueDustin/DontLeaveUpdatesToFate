/**
 * Terminal.tsx: the streaming readout.
 *
 * Deliberately not a terminal emulator. xterm.js would bring a full VT parser for output that has
 * already had its escape sequences stripped in the main process, and its own colour palette, which
 * would put arbitrary ANSI colours on screen and break the house rule that colour carries meaning.
 * Instead each line arrives pre-classified (`command`, `stdout`, `stderr`, `success`, …) and is
 * coloured from the semantic status tokens.
 *
 * Virtualised: a full "update all" run produces tens of thousands of lines, and one DOM node each
 * makes the pane unusable.
 *
 * LONG LINES WRAP. The pane is a few hundred pixels wide and a `winget upgrade` row is about 155
 * characters, so the old behaviour (one row per line, scrolled sideways) meant dragging a scrollbar
 * a long way to read the end of nearly every line. A line now breaks at the pane's edge like a
 * terminal's, at any character, and its continuation rows sit under the text, not under the time.
 * How many characters fit is measured from a hidden probe line, so the windowing knows how tall each
 * line is without rendering it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { LogLevel, LogLine } from '@shared/types';
import { Icon } from './Icon.js';
import { useStickToBottom, useVirtualOffsets, wrappedOffsets } from '../hooks/useVirtual.js';
import { logStore, setTerminalDetached, settingsStore, useStore } from '../state/index.js';

/** Must match `.term__line { line-height }` in app.css. */
const LINE_HEIGHT = 18;

/** Characters per row assumed until the pane has been measured, and the fewest it is ever given. */
const DEFAULT_COLUMNS = 80;
const MIN_COLUMNS = 8;

/** The probe's text: long enough that its width over its length is one character's width. */
const PROBE = '0'.repeat(40);

/**
 * How many characters of log text fit on one row, measured from the hidden probe line: the width the
 * grid gives its text column, over the width of one character in the terminal's face.
 */
function useColumns(probeRef: React.RefObject<HTMLSpanElement | null>): number {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);

  useEffect(() => {
    const cell = probeRef.current;
    const ruler = cell?.firstElementChild;
    if (!cell || !ruler) return;

    const measure = (): void => {
      const one = ruler.getBoundingClientRect().width / PROBE.length;
      if (one <= 0 || cell.clientWidth <= 0) return;
      setColumns(Math.max(MIN_COLUMNS, Math.floor(cell.clientWidth / one)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    // The fallback face is wider than the real one, so measure again once the fonts are in.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [probeRef]);

  return columns;
}

/** Two-character gutter mark per level, the same set the exported log uses. */
const TAG: Record<LogLevel, string> = {
  system: '·',
  command: '$',
  stdout: '',
  stderr: '!',
  success: '✓',
  warn: '!',
  error: '×',
};

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatTime(ts: number): string {
  const base = timeFormatter.format(ts);
  const millis = String(ts % 1000).padStart(3, '0');
  return `${base}.${millis}`;
}

function Line({ line }: { line: LogLine }): JSX.Element {
  return (
    <div className="term__line" data-level={line.level}>
      <span className="term__time">{formatTime(line.ts)}</span>
      <span className="term__tag">{TAG[line.level]}</span>
      <span className="term__text">{line.text}</span>
    </div>
  );
}

export function Terminal(): JSX.Element {
  const lines = useStore(logStore);
  const settings = useStore(settingsStore);
  const scrollRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const columns = useColumns(probeRef);

  const offsets = useMemo(
    () => wrappedOffsets(lines.map((line) => line.text.length), columns, LINE_HEIGHT),
    [lines, columns],
  );
  const totalHeight = offsets[lines.length] ?? 0;

  const onDetached = useCallback((detached: boolean) => setTerminalDetached(detached), []);

  const { detached, jumpToEnd } = useStickToBottom(
    scrollRef,
    // The height, not the count: a resize rewraps every line and moves the bottom without adding one.
    totalHeight,
    settings.followTerminal,
    onDetached,
  );

  const { start, end, offset } = useVirtualOffsets(scrollRef, offsets, 14 * LINE_HEIGHT);

  const slice = useMemo(() => lines.slice(start, end), [lines, start, end]);

  return (
    <div className="term">
      <div className="term__scroll" ref={scrollRef}>
        <div className="term__sizer" style={{ height: totalHeight }}>
          {/* Inside the sizer, so it is laid out in exactly the box the real lines are. */}
          <div className="term__line term__probe" aria-hidden="true">
            <span className="term__time" />
            <span className="term__tag" />
            <span className="term__text" ref={probeRef}>
              <i>{PROBE}</i>
            </span>
          </div>
          <div className="term__window" style={{ transform: `translateY(${offset}px)` }}>
            {slice.map((line) => (
              <Line key={line.seq} line={line} />
            ))}
          </div>
        </div>
      </div>

      {lines.length === 0 && (
        <div className="empty">
          <div className="empty__body">Command output appears here as it streams.</div>
        </div>
      )}

      {detached && settings.followTerminal && (
        <div className="term__pin">
          <button type="button" className="btn btn--secondary btn--sm" onClick={jumpToEnd}>
            <Icon name="chevron-down" size={13} />
            Jump to newest
          </button>
        </div>
      )}
    </div>
  );
}
