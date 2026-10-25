/**
 * StatusTag.tsx: a row's status as a split-flap tag, with a gold seal once the row has updated.
 *
 * The tag's inner word is keyed by status, so each change mounts a fresh word and its flip animation
 * plays (layout.css). Only the tag flips, never the row. The seal stamps in on success. Both move by
 * transform alone: rows may not carry opacity below 1 (app.css contract rule 1).
 */

import type { JSX } from 'react';
import type { JobStatus } from '@shared/types';
import { flapText } from '../state/ledger.js';

export function StatusTag({ status, detail }: { status: JobStatus; detail: string | null }): JSX.Element {
  const word = flapText(status);
  return (
    <span className="status" data-kind={status} title={detail ?? word}>
      {status === 'success' && (
        <span className="status__seal" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="11" height="11">
            <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
      <span className="status__flap">
        <span className="status__word" key={status}>
          {word}
        </span>
      </span>
    </span>
  );
}
