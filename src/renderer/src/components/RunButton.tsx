/**
 * RunButton.tsx: Update all, which becomes its own progress bar while the run goes, with Cancel
 * sliding out of its edge, and shows the result for a moment when it ends.
 *
 * All three faces are rendered and stacked in one grid cell, so the button keeps one width (the widest
 * face) and changing face is a cross-fade, never a layout change. The fill is a scaleX layer.
 */

import type { JSX } from 'react';
import type { RunButtonView } from '../state/actions.js';
import { Icon } from './Icon.js';
import { Ticker } from './Ticker.js';

/** One action per click: only a resting, enabled button starts a run. */
export function pressRun(view: RunButtonView, start: () => void): void {
  if (view.mode === 'idle' && !view.disabled) start();
}

export function RunButton({
  view,
  title,
  onRun,
  onCancel,
}: {
  view: RunButtonView;
  title: string;
  onRun: () => void;
  onCancel: () => void;
}): JSX.Element {
  const running = view.mode === 'running';
  const fill = view.mode === 'running' && view.total > 0 ? view.done / view.total : view.mode === 'finished' ? 1 : 0;

  return (
    <span className="runbtn">
      <button
        type="button"
        className="btn btn--primary runbtn__main"
        data-mode={view.mode}
        disabled={view.mode === 'idle' && view.disabled}
        aria-disabled={view.mode !== 'idle'}
        onClick={() => pressRun(view, onRun)}
        title={title}
        aria-live="polite"
      >
        <span className="runbtn__fill" style={{ transform: `scaleX(${fill})` }} aria-hidden="true" />
        <span className="runbtn__face" data-show={view.mode === 'idle'}>
          <Icon name="download" size={15} />
          {view.mode === 'idle' ? view.label : 'Update all'}
        </span>
        <span className="runbtn__face" data-show={running}>
          Updating <Ticker value={view.mode === 'running' ? view.done : 0} /> of{' '}
          {view.mode === 'running' ? view.total : 0}
        </span>
        <span className="runbtn__face" data-show={view.mode === 'finished'}>
          <svg className="runbtn__check" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {view.mode === 'finished' ? view.label : ''}
        </span>
      </button>

      <button
        type="button"
        className="btn btn--danger btn--slide"
        data-on={running}
        tabIndex={running ? 0 : -1}
        aria-hidden={!running}
        onClick={onCancel}
      >
        <Icon name="stop" size={14} />
        Cancel
      </button>
    </span>
  );
}
