/**
 * Icon.tsx — the icon set, inline.
 *
 * Hand-drawn on a 24-grid with a single 1.6 stroke weight, rather than pulling in an icon package:
 * eight icons do not justify a dependency, and inlining them means they inherit `currentColor` and
 * animate with the rest of the UI for free.
 */

import type { JSX, SVGProps } from 'react';

export type IconName =
  | 'scan'
  | 'download'
  | 'stop'
  | 'settings'
  | 'search'
  | 'export'
  | 'trash'
  | 'shield'
  | 'chevron-down'
  | 'minimise'
  | 'maximise'
  | 'restore'
  | 'close'
  | 'check'
  | 'alert'
  | 'crest'
  | 'inbox'
  | 'skip'
  | 'folder'
  | 'copy'
  | 'more';

const PATHS: Record<IconName, JSX.Element> = {
  scan: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M11 4.5v2M11 15.5v2M4.5 11h2M15.5 11h2" />
      <path d="m15.8 15.8 3.7 3.7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 18.5h15" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m14.6 14.6 4.4 4.4" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V4" />
      <path d="m8 8 4-4 4 4" />
      <path d="M4.5 14v4.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V14" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5l7 2.6v5.3c0 4.2-2.9 7.6-7 9.1-4.1-1.5-7-4.9-7-9.1V6.1z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </>
  ),
  'chevron-down': <path d="m6.5 9.75 5.5 5 5.5-5" />,
  minimise: <path d="M5 12h14" />,
  maximise: <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />,
  restore: (
    <>
      <rect x="4.5" y="7.5" width="11" height="11" rx="1.5" />
      <path d="M8.5 7.5V6A1.5 1.5 0 0 1 10 4.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4.2" />
      <path d="M12 16.8v.2" />
    </>
  ),
  skip: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m6.6 6.6 10.8 10.8" />
    </>
  ),
  /** Reveal in Explorer. The raised tab keeps it readable at 12px, where a plain rectangle does not. */
  folder: (
    <>
      <path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h3.4l2 2.3h7.7a1.7 1.7 0 0 1 1.7 1.7v8.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="10.5" height="10.5" rx="2" />
      <path d="M15 6.2A1.7 1.7 0 0 0 13.3 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2v7.1A1.7 1.7 0 0 0 6.2 15" />
    </>
  ),
  /** Row overflow. Filled dots rather than stroked circles, which turn to mush at 14px. */
  more: (
    <>
      <circle cx="12" cy="5.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.4" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5h4l1.4 2.6h6.2l1.4-2.6h4" />
      <path d="M3.5 13.5 6.2 5.6A1.5 1.5 0 0 1 7.6 4.5h8.8a1.5 1.5 0 0 1 1.4 1.1l2.7 7.9v4.4a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </>
  ),
  /**
   * The crest: a geometric mark, per the charted tier's "geometric rather than illustrative" rule.
   * A diamond inside a rotated square, with a broken outer ring — the "thread" of the house story
   * drawn as an interrupted circle rather than a closed one.
   */
  crest: (
    <>
      <path d="M12 2.6 21.4 12 12 21.4 2.6 12z" />
      <path d="M12 7.4 16.6 12 12 16.6 7.4 12z" />
      <path d="M12 10.7 13.3 12 12 13.3 10.7 12z" fill="currentColor" stroke="none" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
