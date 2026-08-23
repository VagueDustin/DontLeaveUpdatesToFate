/**
 * Terminal.tsx — the streaming readout.
 *
 * Deliberately not a terminal emulator. xterm.js would bring a full VT parser for output that has
 * already had its escape sequences stripped in the main process, and its own colour palette — which
 * would put arbitrary ANSI colours on screen and break the house rule that colour carries meaning.
 * Instead each line arrives pre-classified (`command`, `stdout`, `stderr`, `success`, …) and is
 * coloured from the semantic status tokens.
 *
 * Virtualised at a fixed 18px line height: a full "update all" run produces tens of thousands of
 * lines, and one DOM node each makes the pane unusable.
 */

import { useCallback, useMemo, useRef, type JSX } from 'react';
import type { LogLevel, LogLine } from '@shared/types';
import { Icon } from './Icon.js';
import { useStickToBottom, useVirtual } from '../hooks/useVirtual.js';
import { logStore, setTerminalDetached, settingsStore, useStore } from '../state/index.js';

/** Must match `.term__line { line-height }` in app.css. */
const LINE_HEIGHT = 18;

/** Two-character gutter mark per level — the same set the exported log uses. */
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
    <div className="term__line" data-level={line.level} style={{ height: LINE_HEIGHT }}>
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

  const onDetached = useCallback((detached: boolean) => setTerminalDetached(detached), []);

  const { detached, jumpToEnd } = useStickToBottom(
    scrollRef,
    lines.length,
    settings.followTerminal,
    onDetached,
  );

  const { start, end, offset, totalHeight } = useVirtual(scrollRef, {
    count: lines.length,
    rowHeight: LINE_HEIGHT,
    overscan: 14,
  });

  const slice = useMemo(() => lines.slice(start, end), [lines, start, end]);

  return (
    <div className="term">
      <div className="term__scroll" ref={scrollRef}>
        <div className="term__sizer" style={{ height: totalHeight }}>
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
