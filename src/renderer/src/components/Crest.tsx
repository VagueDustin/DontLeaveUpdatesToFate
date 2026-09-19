/**
 * Crest.tsx — the house mark, doing a job.
 *
 * The title bar already carries a crest on every screen of the app, and while a run is going it is
 * the only mark on screen that is always visible — the progress hairline is 2px, the row statuses are
 * below the fold as soon as the table scrolls. So it becomes the readout: an hourglass whose sand
 * falls as the run does.
 *
 * It is a REAL reading, not an ornament. The level is `done / total` from the run snapshot, which is
 * the same arithmetic the progress bar uses, so the two can never disagree. Idle, it is simply the
 * crest, full and still.
 *
 * WHY AN HOURGLASS. Because it is already the brand — the hero artwork is a gold hourglass on a navy
 * medallion — and because a proportion is exactly what an hourglass is for. A spinner says "working";
 * an hourglass says "this far through".
 *
 * The sand level is driven by `--fate-sand`, registered in fate/tokens.css so it INTERPOLATES. An
 * unregistered custom property inside a gradient snaps between values, which would make the sand jump
 * a package at a time instead of falling.
 */

import type { JSX } from 'react';
import { runStore, useStore } from '../state/index.js';

export function Crest({ size = 22 }: { size?: number }): JSX.Element {
  const run = useStore(runStore);

  const total = run.jobs.length;
  const done = run.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running').length;
  const running = run.phase === 'running' && total > 0;

  /*
    0 = full, 1 = run through.

    Gated on whether jobs EXIST, not on whether one is in progress. Tying it to `running` made the
    sand spring back to full the instant a run finished — an hourglass reading "nothing has happened"
    directly above a table full of results, which is the opposite of the truth. A finished run leaves
    its sand at the bottom, exactly as a real one would; only a session with no run at all shows the
    crest at rest.

    Caught by measuring the three preview states rather than by looking at one.
  */
  const fallen = total > 0 ? Math.min(1, done / total) : 0;

  return (
    <svg
      className="crest"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-running={running ? 'true' : undefined}
      style={{ ['--fate-sand' as string]: fallen }}
    >
      {/* Frame: the two plates and the posts. Static — this is the instrument, not the reading. */}
      <path
        className="crest__frame"
        d="M5.5 3h13M5.5 21h13M7 3v2.2c0 2.2 5 4.1 5 6.8s-5 4.6-5 6.8V21M17 3v2.2c0 2.2-5 4.1-5 6.8s5 4.6 5 6.8V21"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/*
        The two bulbs of sand, clipped to the glass.

        Drawn as rectangles behind a clip rather than as morphing paths: a path that changes shape is
        a new path on every frame and cannot be interpolated by the compositor, where a rectangle
        moved by `y` can. The upper bulb empties downward, the lower fills upward.
      */}
      <defs>
        <clipPath id="crest-upper">
          <path d="M7.6 4.2h8.8c0 2.4-4.4 4.3-4.4 7.1 0-2.8-4.4-4.7-4.4-7.1Z" />
        </clipPath>
        <clipPath id="crest-lower">
          <path d="M12 12.7c0 2.8 4.4 4.7 4.4 7.1H7.6c0-2.4 4.4-4.3 4.4-7.1Z" />
        </clipPath>
      </defs>

      {/* Upper: full at rest, sliding out of its own clip as the run progresses. */}
      <rect
        className="crest__sand crest__sand--upper"
        x="6"
        y="3"
        width="12"
        height="9"
        clipPath="url(#crest-upper)"
      />

      {/* Lower: rises by the same proportion. */}
      <rect
        className="crest__sand crest__sand--lower"
        x="6"
        y="12"
        width="12"
        height="9"
        clipPath="url(#crest-lower)"
      />
    </svg>
  );
}
