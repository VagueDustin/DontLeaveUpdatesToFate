/**
 * Toasts.tsx — transient confirmations.
 *
 * Only used for things that happen outside the user's field of view: a log written to disk, an
 * elevation prompt declined. Scan and run outcomes already have a permanent home in the stat tiles
 * and the terminal, so surfacing them here as well would be noise.
 */

import type { JSX } from 'react';
import { Icon } from './Icon.js';
import { dismissToast, toastStore, useStore } from '../state/index.js';

const ICON = {
  success: 'check',
  error: 'alert',
  info: 'shield',
} as const;

export function Toasts(): JSX.Element | null {
  const toasts = useStore(toastStore);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((entry) => (
        <div className="toast" key={entry.id} data-kind={entry.kind}>
          <Icon
            name={ICON[entry.kind]}
            size={16}
            style={{
              color:
                entry.kind === 'success'
                  ? 'var(--status-success)'
                  : entry.kind === 'error'
                    ? 'var(--status-danger)'
                    : 'var(--accent-default)',
              flex: 'none',
            }}
          />
          <span className="toast__text">{entry.text}</span>
          {entry.action && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                entry.action?.run();
                dismissToast(entry.id);
              }}
            >
              {entry.action.label}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => dismissToast(entry.id)}
            aria-label="Dismiss"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
