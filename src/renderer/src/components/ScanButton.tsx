/**
 * ScanButton.tsx: Scan, which reads "Scanning" and fills as managers report, with a small Stop button
 * sliding out beside it. It is never swapped for a different button.
 */

import type { JSX } from 'react';
import type { ScanButtonView } from '../state/actions.js';
import { Icon } from './Icon.js';

export function ScanButton({
  view,
  disabled,
  onScan,
  onStop,
}: {
  view: ScanButtonView;
  disabled: boolean;
  onScan: () => void;
  onStop: () => void;
}): JSX.Element {
  const scanning = view.mode === 'scanning';
  return (
    <span className="runbtn">
      <button
        type="button"
        className="btn btn--secondary scanbtn"
        data-mode={view.mode}
        disabled={disabled && !scanning}
        aria-disabled={scanning}
        onClick={() => {
          if (!scanning) onScan();
        }}
        title="Ask every available manager what has fallen behind."
      >
        <span className="runbtn__fill" style={{ transform: `scaleX(${view.progress})` }} aria-hidden="true" />
        <span className="runbtn__face" data-show="true">
          <Icon name="scan" size={15} />
          {view.label}
        </span>
      </button>

      <button
        type="button"
        className="btn btn--danger btn--sm btn--icon btn--slide"
        data-on={scanning}
        tabIndex={scanning ? 0 : -1}
        aria-hidden={!scanning}
        aria-label="Stop scan"
        title="Stop scan"
        onClick={onStop}
      >
        <Icon name="stop" size={13} />
      </button>
    </span>
  );
}
