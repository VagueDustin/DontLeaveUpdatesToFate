/**
 * Ticker.tsx: a number that rolls to its new value.
 *
 * The value span is keyed by the value, so every change mounts a fresh span and its entry animation
 * (in controls.css) plays: the new number rises into place. Reduced motion turns that into an instant
 * swap through the global motion rules, so nothing here needs to know about it.
 */

import type { JSX } from 'react';

export function Ticker({ value }: { value: number | string }): JSX.Element {
  return (
    <span className="ticker">
      <span className="ticker__value" key={String(value)}>
        {value}
      </span>
    </span>
  );
}
