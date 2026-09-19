/**
 * VersionBadge.tsx: the version in the footer, made answerable.
 *
 * THE PROBLEM THIS SOLVES. This app has been able to update itself since 1.2.0, check, download,
 * verify against the published SHA-256, and hand over to either the installer or an in-place swap of
 * the portable build. None of that was discoverable. `UpdateBar` renders nothing at all unless a
 * newer release already exists (UpdateBar.tsx), and the only manual control was a "Check now" button
 * four screens down inside Settings. So to anyone running the current version, which is nearly
 * everyone, nearly all of the time, the app simply appeared not to have the feature.
 *
 * WHY HERE. `UpdateBar` states its own principle plainly: an app that permanently reserves a row to
 * tell you it is up to date has spent layout on a non-event. That is right, and this does not break
 * it. The footer row already exists and already renders the version as inert text; this makes that
 * existing text answer a question instead of adding a new surface to ignore. Nothing grows, nothing
 * moves, nothing appears.
 *
 * The strip above remains the place an ACTIONABLE update is announced. This is only the affordance
 * for asking.
 */

import type { JSX } from 'react';
import type { AppInfo, UpdateState } from '@shared/types';
import { checkForUpdate, updateStore, useStore } from '../state/index.js';

/**
 * What the badge says next to the version.
 *
 * Deliberately terse: this is 10px text in a footer, not a status panel. The strip above carries
 * the detail when there is something to act on.
 */
function note(state: UpdateState): { text: string; tone: 'idle' | 'busy' | 'new' | 'bad' } {
  switch (state.stage) {
    case 'checking':
      return { text: 'checking…', tone: 'busy' };
    case 'downloading':
      return { text: 'downloading…', tone: 'busy' };
    case 'available':
    case 'ready':
      return { text: `${state.release?.version ?? 'update'} available`, tone: 'new' };
    case 'error':
      return { text: 'check failed', tone: 'bad' };
    case 'current':
      return { text: 'up to date', tone: 'idle' };
    default:
      return { text: 'check for updates', tone: 'idle' };
  }
}

export function VersionBadge({ info }: { info: AppInfo }): JSX.Element {
  const state = useStore(updateStore);

  /*
    The Store build is not a variant of this control, it is the absence of one.

    Windows owns an MSIX package: it cannot be replaced in place, and the app is not permitted to try.
    A button here would be offering something that cannot happen, so the badge states the version and
    names who is responsible instead.
  */
  if (state.channel === 'store') {
    return (
      <span className="verbadge verbadge--managed" title="Updates are delivered by the Microsoft Store">
        <span>v{info.version}</span>
        <span aria-hidden="true">·</span>
        <span>Microsoft Store</span>
      </span>
    );
  }

  const busy = state.stage === 'checking' || state.stage === 'downloading';
  const { text, tone } = note(state);

  return (
    <button
      type="button"
      className="verbadge"
      data-tone={tone}
      disabled={busy}
      onClick={() => void checkForUpdate()}
      /* The accessible name has to carry what the visual does, and the visual leans on a dot and a
         colour that a screen reader cannot see. */
      aria-label={`Version ${info.version}, ${info.portable ? 'portable' : 'installed'}, ${text}. Check for updates.`}
      title={
        state.checkedAt
          ? `Last checked ${new Date(state.checkedAt).toLocaleTimeString()}`
          : 'Ask GitHub whether there is a newer release'
      }
    >
      <span className="verbadge__dot" aria-hidden="true" />
      <span>v{info.version}</span>
      <span aria-hidden="true">·</span>
      <span>{info.portable ? 'portable' : 'installed'}</span>
      <span className="verbadge__note">{text}</span>
    </button>
  );
}
