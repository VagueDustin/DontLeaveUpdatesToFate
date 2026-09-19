/**
 * TerminalDrawer.tsx — the transcript, out of the way until it is worth the space.
 *
 * The terminal used to be a fixed half of a split. For most of a session that is the wrong trade: the
 * table is what is being read, and the log only becomes interesting while something is happening or
 * immediately after it went wrong. Half the window is a lot to spend on a surface nobody is looking
 * at.
 *
 * So it is a drawer. Closed it is one 34px bar carrying the latest line, which is genuinely all the
 * information a resting log has. It opens itself when a run starts (`startRun` calls
 * `autoOpenTerminal`) and it does NOT close itself when the run ends — a finishing run is when the
 * transcript matters most, not least, and taking it away at that exact moment would be the worst
 * possible timing. The user closes it.
 *
 * The collapsed bar is a button rather than a header with a button in it, so the whole 34px strip is
 * the hit area. The export and clear controls stay reachable in both states, because wanting to keep
 * a log you are not currently reading is an ordinary thing to want.
 */

import type { JSX } from 'react';
import { Icon } from './Icon.js';
import { LogControls } from './LogControls.js';
import { Terminal } from './Terminal.js';
import { logStore, toggleTerminal, uiStore, useStore } from '../state/index.js';

/** Levels that deserve their colour in the one-line summary. Everything else reads as plain text. */
const SUMMARY_TONE: Partial<Record<string, string>> = {
  error: 'error',
  warn: 'warn',
  success: 'success',
  command: 'command',
};

export function TerminalDrawer(): JSX.Element {
  const ui = useStore(uiStore);
  const lines = useStore(logStore);

  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  const open = ui.terminalOpen;

  return (
    <section className="drawer" data-open={open ? 'true' : undefined}>
      <div className="drawer__bar">
        <button
          type="button"
          className="drawer__toggle"
          onClick={toggleTerminal}
          aria-expanded={open}
          aria-controls="terminal-body"
          title={open ? 'Collapse the terminal' : 'Expand the terminal'}
        >
          <Icon name="chevron-down" size={13} className="drawer__chevron" />
          <span className="drawer__label">Terminal</span>

          {/*
            The latest line, shown only when collapsed. Expanded it would be a duplicate of the line
            directly beneath it, which is the kind of redundancy that makes a UI feel padded.
          */}
          {!open && last && (
            <span className="drawer__last" data-tone={SUMMARY_TONE[last.level]}>
              {last.text}
            </span>
          )}

          {/* No line count here: LogControls already renders one, immediately to the right. */}
        </button>

        <LogControls />
      </div>

      {/*
        Unmounted rather than hidden when closed.

        The terminal renders a virtualised window over up to fifty thousand lines and subscribes to a
        store that appends up to twenty-five times a second during a run. Keeping that mounted behind
        `display: none` would do all of that work to paint nothing.
      */}
      {open && (
        <div className="drawer__body" id="terminal-body">
          <Terminal />
        </div>
      )}
    </section>
  );
}
