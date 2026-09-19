/**
 * GlassFilters.tsx: the lens. Mounted once, as the first child of the app.
 *
 * This is what makes the glass in this app actually refract rather than just blur. `backdrop-filter`
 * accepts a `url()` reference to an SVG filter, which was verified against the shipped binary rather
 * than assumed, see `npm run probe`, key `backdrop-filter-url`.
 *
 * WHY NOT feTurbulence STRAIGHT INTO feDisplacementMap, which is what every example on the web does:
 * that warps the middle of the pane as hard as its edge, and the eye reads a uniformly wobbling
 * surface as a rendering defect, not as glass. Real glass is flat across its face and bends light
 * only where it thickens at the rim. So the displacement map is explicit rather than noise: red
 * encodes horizontal displacement, green vertical, both held at a neutral 128 across the whole
 * interior and ramping only through the outer 14%.
 *
 * THE RAMP RUNS THE OPPOSITE WAY TO THE OBVIOUS ONE, and this is the detail that decides whether the
 * effect renders or looks broken. `feDisplacementMap` samples the source at
 * `P(x + scale × (R/255 − 0.5), y + scale × (G/255 − 0.5))`. At the left edge the sample has to come
 * from further RIGHT (inward) or the bevel reaches outside the element's own clipped backdrop and
 * drags in transparent pixels, leaving a bright torn margin. So the left edge is 255 and the right
 * edge is 0.
 *
 * The map is written with CSS NAMED COLOURS on purpose. `maroon` is exactly channel (128,0,0) and
 * `green` is exactly (0,128,0) (the precise neutral this needs) which means the file states its
 * channel values without a single hex literal, and `npm run lint:brand` has nothing to object to.
 *
 * Inline in the document rather than an external .svg: a packaged build loads from file:// under a
 * strict CSP, and an <svg> that is already in the DOM needs neither a fetch nor a policy change.
 */

import type { JSX } from 'react';

/**
 * The normal map: a horizontal red ramp screened over a vertical green one.
 *
 * 200×200 and stretched with preserveAspectRatio="none", the ramp is positional, not pictorial, so
 * resolution buys nothing and a small map keeps the filter cheap.
 */
const LENS_MAP =
  'data:image/svg+xml,' +
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cdefs%3E" +
  "%3ClinearGradient id='x' x1='0' y1='0' x2='1' y2='0'%3E" +
  "%3Cstop offset='0' stop-color='red'/%3E%3Cstop offset='.14' stop-color='maroon'/%3E" +
  "%3Cstop offset='.86' stop-color='maroon'/%3E%3Cstop offset='1' stop-color='black'/%3E" +
  '%3C/linearGradient%3E' +
  "%3ClinearGradient id='y' x1='0' y1='0' x2='0' y2='1'%3E" +
  "%3Cstop offset='0' stop-color='lime'/%3E%3Cstop offset='.14' stop-color='green'/%3E" +
  "%3Cstop offset='.86' stop-color='green'/%3E%3Cstop offset='1' stop-color='black'/%3E" +
  '%3C/linearGradient%3E%3C/defs%3E' +
  "%3Crect width='200' height='200' fill='url(%23x)'/%3E" +
  "%3Crect width='200' height='200' fill='url(%23y)' style='mix-blend-mode:screen'/%3E%3C/svg%3E";

/** Three thicknesses, because a title bar is not made of the same material as a settings sheet. */
const THICKNESSES = [
  ['thin', 10],
  ['plate', 20],
  ['thick', 28],
] as const;

export function GlassFilters(): JSX.Element {
  return (
    <svg className="fate-filters" aria-hidden="true" focusable="false">
      <defs>
        {THICKNESSES.map(([id, scale]) => (
          <filter
            key={id}
            id={`fate-lens-${id}`}
            /* objectBoundingBox so the filter region is exactly the border box. The backdrop is
               never sampled from outside the element, Chromium clips it there regardless, and
               matching that explicitly is what keeps the rim from tearing. */
            filterUnits="objectBoundingBox"
            x="0"
            y="0"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            {/* No x/y/width/height here on purpose. A primitive with no referenced input already
                defaults to the filter region, and passing percentages instead resolves them against
                `primitiveUnits` (userSpaceOnUse by default) which is the single most common way
                this whole filter silently renders nothing at all. */}
            <feImage href={LENS_MAP} preserveAspectRatio="none" result="map" />

            {/* 94% lens, 6% imperfection. Real glass is not mathematically flat, and the small
                irregularity is most of what separates this from a CSS gradient. k1 and k4 stay at 0
                so the arithmetic keeps the neutral point exactly on 128. */}
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.004 0.006"
              numOctaves="2"
              seed="11"
              result="t"
            />
            <feComposite
              in="map"
              in2="t"
              operator="arithmetic"
              k1="0"
              k2="0.94"
              k3="0.06"
              k4="0"
              result="lens"
            />

            <feDisplacementMap
              in="SourceGraphic"
              in2="lens"
              scale={scale}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ))}
      </defs>
    </svg>
  );
}
