/**
 * UpdateBar.tsx — "there is a newer version of this".
 *
 * A strip under the title bar rather than a toast or a modal. A toast disappears while you are reading
 * the terminal, and a modal interrupts a run — neither is right for something that is true until acted
 * on and urgent in no particular moment. The strip stays until it is dealt with and never covers
 * anything.
 *
 * It renders nothing at all when there is nothing to say. An app that permanently reserves a row to
 * tell you it is up to date has spent layout on a non-event.
 */

import type { JSX } from 'react';
import type { UpdateState } from '@shared/types';
import { Icon } from './Icon.js';
import {
  cancelUpdateDownload,
  dismissUpdate,
  downloadUpdate,
  installUpdate,
  updateStore,
  useStore,
} from '../state/index.js';

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** What the primary button offers, given the stage and what this build can actually do. */
function action(state: UpdateState): { label: string; icon: 'download' | 'check'; run: () => void } | null {
  if (state.stage === 'available') {
    if (!state.release?.assetName) return null;
    return { label: 'Download', icon: 'download', run: () => void downloadUpdate() };
  }
  if (state.stage === 'ready') {
    return {
      label: state.channel === 'portable' ? 'Replace and restart' : 'Close and install',
      icon: 'check',
      run: () => void installUpdate(),
    };
  }
  return null;
}

export function UpdateBar(): JSX.Element | null {
  const state = useStore(updateStore);

  // The Store channel never shows this strip. Windows owns the package and nothing here can act on
  // a newer version, so an alert offering one would be an alert about somebody else's job.
  const showing =
    state.channel !== 'store' &&
    (state.stage === 'available' || state.stage === 'downloading' || state.stage === 'ready');
  if (!showing || !state.release) return null;

  const { release } = state;
  const primary = action(state);
  const percent = state.total > 0 ? Math.min(100, (state.received / state.total) * 100) : 0;

  return (
    <div className="updatebar glass" data-stage={state.stage} role="status" aria-live="polite">
      <Icon name="download" size={15} className="updatebar__mark" />

      <span className="updatebar__text">
        {state.stage === 'downloading' ? (
          <>
            Downloading {release.version} — {megabytes(state.received)}
            {state.total > 0 && ` of ${megabytes(state.total)}`}
          </>
        ) : state.stage === 'ready' ? (
          <>
            <strong>{release.version} is ready.</strong>{' '}
            {state.verified
              ? 'Verified against the checksum published with the release.'
              : 'That release published no checksum, so only its size was checked.'}
          </>
        ) : (
          <>
            <strong>{release.version} is available.</strong> You are on {state.current}.
            {!release.assetName && ' That release has no build for this kind of install.'}
          </>
        )}
      </span>

      {state.stage === 'downloading' && (
        <span className="updatebar__meter" aria-hidden="true">
          <span className="updatebar__fill" style={{ width: `${percent}%` }} />
        </span>
      )}

      <div className="updatebar__grow" />

      <button
        type="button"
        className="link"
        onClick={() => void window.fate.openExternal(release.notesUrl)}
      >
        What&rsquo;s new
      </button>

      {state.stage === 'downloading' ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void cancelUpdateDownload()}
        >
          <Icon name="stop" size={13} />
          Cancel
        </button>
      ) : (
        primary && (
          <button type="button" className="btn btn--primary btn--sm" onClick={primary.run}>
            <Icon name={primary.icon} size={13} />
            {primary.label}
          </button>
        )
      )}

      {state.stage !== 'downloading' && (
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={dismissUpdate}
          aria-label="Dismiss until the next check"
          title="Dismiss until the next check"
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  );
}
