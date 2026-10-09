/**
 * check-terminal.mjs: regression check for the terminal readout collapsing to a sliver.
 *
 * `.drawer__body` was a row flexbox, so `.term` took its max-content width. Every line lives in an
 * absolutely positioned window that contributes no width, so the terminal came out 45px wide: all
 * the lines were in the DOM, the line count was right, and on screen there was one digit of each
 * timestamp and nothing else. A unit test cannot see that, so this opens the drawer in the design
 * harness and measures what is actually laid out.
 *
 *   FATE_SHOT_URL=http://localhost:5199/preview.html npx electron scripts/check-terminal.mjs
 *
 * Exits non-zero when the terminal does not fill the drawer or its newest line cannot be hit.
 */

import { app, BrowserWindow } from 'electron';

const BASE = process.env.FATE_SHOT_URL ?? 'http://localhost:5199/preview.html';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ width: 1400, height: 900, show: false, frame: false });
    await window.loadURL(`${BASE}?state=finished`);
    await new Promise((r) => setTimeout(r, 1400));

    const result = await window.webContents.executeJavaScript(`(async () => {
      const toggle = document.querySelector('.drawer__toggle');
      if (!toggle) return { error: 'no drawer toggle' };
      if (!document.querySelector('.drawer[data-open]')) toggle.click();
      // A timer rather than requestAnimationFrame: a hidden window does not tick frames, layout is
      // still computed on demand by getBoundingClientRect.
      await new Promise((r) => setTimeout(r, 400));

      const body = document.querySelector('.drawer__body');
      const term = document.querySelector('.term');
      const scroll = document.querySelector('.term__scroll');
      const lines = [...document.querySelectorAll('.term__line')];
      if (!body || !term || !scroll) return { error: 'the drawer did not open' };
      if (lines.length === 0) return { error: 'no lines rendered' };

      // The newest line should be on screen (the view follows the tail) and be the topmost element
      // where its text begins, not clipped away by its own scroll container.
      const text = lines[lines.length - 1].querySelector('.term__text');
      const box = text.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2);

      return {
        bodyWidth: Math.round(body.getBoundingClientRect().width),
        termWidth: Math.round(term.getBoundingClientRect().width),
        scrollClientWidth: scroll.clientWidth,
        renderedLines: lines.length,
        newestLineHit: !!hit && text.contains(hit),
      };
    })()`);

    console.log(JSON.stringify(result, null, 2));

    const ok =
      !result.error &&
      Math.abs(result.termWidth - result.bodyWidth) <= 1 &&
      result.scrollClientWidth >= result.bodyWidth / 2 &&
      result.newestLineHit;
    if (!ok) console.error('FAILED: the terminal does not fill the drawer.');

    window.destroy();
    app.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(`FAILED: ${error?.message ?? error}`);
    app.exit(1);
  });
