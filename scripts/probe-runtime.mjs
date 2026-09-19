/**
 * probe-runtime.mjs: what this Chromium actually supports, measured rather than assumed.
 *
 * The version number lies. Electron 43 ships Chromium 150, so a reasonable person reads "Electron 43"
 * and writes CSS for a 2020 engine, when in fact almost everything published since is available. This
 * script exists so that question is answered by the binary rather than by a guess, and so the two
 * features that are NOT available are recorded as facts rather than rediscovered by someone pasting
 * from a blog post.
 *
 * Deliberately NOT part of `npm run verify`. This launches a real Electron and opens a window; the
 * fast suite is hermetic on purpose, the same reason tests/integration.test.ts sits behind
 * FATE_INTEGRATION=1. Run it when changing the instrument layer, or when Electron is upgraded:
 *
 *   npm run probe
 *
 * Exits non-zero if reality has diverged from EXPECTED below, which, on an Electron bump, is
 * information rather than a failure. Read the diff, then update the table.
 */

import { app, BrowserWindow } from 'electron';

/**
 * The features the instrument layer is built on, plus the two it must never be built on.
 *
 * `false` entries are load-bearing. `view-transition-name: auto` and `animation-trigger` are both
 * widely written about and neither exists here; pinning them means a future contributor who reaches
 * for one gets a failed probe instead of a silently dead rule.
 */
const EXPECTED = {
  // The glass and engraving layer
  'backdrop-filter': true,
  'backdrop-filter-url': true,
  'mask-composite': true,
  'mix-blend-mode-plus-lighter': true,
  'color-mix': true,
  'relative-color': true,
  'corner-shape': true,

  // Motion
  '@property': true,
  'linear-easing': true,
  '@starting-style': true,
  'transition-behavior-discrete': true,
  'scroll-timeline': true,
  'timeline-scope': true,
  'view-transitions': true,
  'view-transition-name-auto': false,
  'animation-trigger': false,

  // Layout and interaction
  ':has': true,
  'container-queries': true,
  'anchor-positioning': true,
  popover: true,
  'field-sizing': true,
  'interpolate-size': true,

  // Accessibility levers the kill switch depends on
  'prefers-reduced-motion': true,
  'prefers-reduced-transparency': true,
};

/** Each probe runs inside the page and answers exactly one question. */
const PROBES = `(() => {
  const supports = (prop, value) => CSS.supports(prop, value);
  const rule = (text) => {
    // CSS.supports cannot answer at-rule questions; parsing one is the only honest test.
    try {
      const sheet = new CSSStyleSheet();
      sheet.insertRule(text);
      return sheet.cssRules.length === 1;
    } catch {
      return false;
    }
  };
  const media = (query) => matchMedia(query).media !== 'not all';

  return {
    'backdrop-filter': supports('backdrop-filter', 'blur(4px) saturate(140%)'),
    'backdrop-filter-url': supports('backdrop-filter', 'url(#f)'),
    'mask-composite': supports('mask-composite', 'exclude'),
    'mix-blend-mode-plus-lighter': supports('mix-blend-mode', 'plus-lighter'),
    'color-mix': supports('color', 'color-mix(in oklab, red 50%, blue)'),
    'relative-color': supports('color', 'oklch(from red l c h)'),
    'corner-shape': supports('corner-shape', 'squircle'),

    '@property': rule('@property --probe { syntax: "<length>"; inherits: false; initial-value: 0px; }'),
    'linear-easing': supports('transition-timing-function', 'linear(0, 0.5, 1)'),
    '@starting-style': rule('@starting-style { .probe { opacity: 0; } }'),
    'transition-behavior-discrete': supports('transition-behavior', 'allow-discrete'),
    'scroll-timeline': supports('animation-timeline', 'scroll(root block)'),
    'timeline-scope': supports('timeline-scope', '--probe'),
    'view-transitions': typeof document.startViewTransition === 'function',
    'view-transition-name-auto': supports('view-transition-name', 'auto'),
    'animation-trigger': supports('animation-trigger', 'once'),

    ':has': supports('selector(:has(.x))', '') || CSS.supports('selector(:has(*))'),
    'container-queries': supports('container-type', 'inline-size'),
    'anchor-positioning': supports('anchor-name', '--probe'),
    popover: HTMLElement.prototype.hasOwnProperty('popover'),
    'field-sizing': supports('field-sizing', 'content'),
    'interpolate-size': supports('interpolate-size', 'allow-keywords'),

    'prefers-reduced-motion': media('(prefers-reduced-motion: reduce)'),
    'prefers-reduced-transparency': media('(prefers-reduced-transparency: reduce)'),
  };
})()`;

/** Never leave a probe process behind. One orphan holds a DLL and the next `npm ci` fails with EPERM. */
function finish(code) {
  process.exitCode = code;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.quit();
}

app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      webPreferences: { offscreen: true },
    });

    // about:blank is enough: every probe is a parser or a media query, none needs content.
    await window.loadURL('about:blank');
    const actual = await window.webContents.executeJavaScript(PROBES);

    const rows = Object.keys(EXPECTED).sort();
    const width = Math.max(...rows.map((r) => r.length));
    const wrong = [];

    console.log(`\nChromium ${process.versions.chrome}  ·  Electron ${process.versions.electron}\n`);
    for (const key of rows) {
      const want = EXPECTED[key];
      const got = actual[key];
      const ok = want === got;
      if (!ok) wrong.push({ key, want, got });
      console.log(`  ${ok ? 'ok  ' : 'DIFF'}  ${key.padEnd(width)}  ${got}${ok ? '' : `  (expected ${want})`}`);
    }

    if (wrong.length > 0) {
      console.error(`\n${wrong.length} feature(s) diverged from the recorded baseline.`);
      console.error('This is information, not necessarily a fault, read the diff, then update EXPECTED.\n');
      finish(1);
      return;
    }

    console.log(`\nall ${rows.length} features match the recorded baseline.\n`);
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
