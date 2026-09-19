/**
 * check-glass.mjs: assert the glass layer is actually doing what it claims.
 *
 * This exists because two bugs got through by looking fine:
 *
 *   1. The settings sheet had the specular hook wired to it while still carrying its own
 *      backdrop-filter and no `.glass` class, so the highlight wrote properties nothing consumed.
 *      A screenshot could not show that.
 *   2. `.glass` set `position: relative`, which, loading after app.css, overrode `position: fixed`
 *      on the portalled export menu. Its inline left/top then resolved against its static flow
 *      position instead of the viewport, so the menu opened off-screen and pressing Export appeared
 *      to do nothing. Nothing about that is visible in a screenshot of the main window either.
 *
 * So the three things that cannot be eyeballed are measured: the filter is present when glass is on,
 * genuinely absent when off (a `blur(0px)` still samples the backdrop at full cost, so "it looks
 * flat" is not evidence), and every glass surface establishes a containing block for its own pseudos.
 *
 * Requires `node scripts/preview-server.mjs` to be running.
 *
 *   npm run check:glass
 */

import { app, BrowserWindow } from 'electron';

const BASE = process.env.FATE_GLASS_URL ?? 'http://localhost:5199/preview.html?state=settings';

/** Every surface the instrument layer puts glass on, and where it is expected to be reachable. */
const SURFACES = [
  { selector: '.titlebar', label: 'title bar' },
  { selector: '.sheet', label: 'settings sheet' },
];

function finish(code) {
  process.exitCode = code;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.quit();
}

app.on('window-all-closed', () => app.quit());

/** Runs in the page: flip data-glass, then report each surface's filter and its own position. */
const probe = (selectors, glass) => `(() => {
  document.documentElement.dataset.glass = ${JSON.stringify(glass)};
  return JSON.stringify(${JSON.stringify(selectors)}.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    return {
      sel,
      filter: getComputedStyle(el, '::before').backdropFilter,
      position: getComputedStyle(el).position,
    };
  }));
})()`;

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
    await window.loadURL(BASE);
    // The sheet is rendered by React and the harness settles its stores first.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const selectors = SURFACES.map((s) => s.selector);
    const on = JSON.parse(await window.webContents.executeJavaScript(probe(selectors, 'on')));
    const off = JSON.parse(await window.webContents.executeJavaScript(probe(selectors, 'off')));

    const failures = [];
    console.log('');

    for (const [index, surface] of SURFACES.entries()) {
      const a = on[index];
      const b = off[index];

      if (a.missing) {
        failures.push(`${surface.label}: not in the DOM (selector ${surface.selector})`);
        console.log(`  MISSING  ${surface.label}`);
        continue;
      }

      const hasFilter = a.filter.includes('url(') || a.filter.includes('blur(');
      const clears = b.filter === 'none';
      // `static` means the ::before/::after would escape to the nearest positioned ancestor.
      const positioned = a.position !== 'static';

      if (!hasFilter) failures.push(`${surface.label}: no backdrop-filter with glass on (${a.filter})`);
      if (!clears) failures.push(`${surface.label}: filter survives data-glass=off (${b.filter})`);
      if (!positioned) failures.push(`${surface.label}: position is static, so its pseudos escape`);

      const mark = hasFilter && clears && positioned ? 'ok  ' : 'FAIL';
      console.log(`  ${mark}     ${surface.label}`);
      console.log(`             position ${a.position}`);
      console.log(`             on       ${a.filter}`);
      console.log(`             off      ${b.filter}`);
    }

    console.log('');
    if (failures.length > 0) {
      for (const line of failures) console.error(`  ${line}`);
      console.error('');
      finish(1);
      return;
    }

    console.log(`  all ${SURFACES.length} glass surfaces behave as declared.\n`);
    finish(0);
  })
  .catch((error) => {
    console.error(error);
    finish(1);
  });
