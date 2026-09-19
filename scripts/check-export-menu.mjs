/**
 * check-export-menu.mjs: regression check for the export menu being clipped out of existence.
 *
 * The menu's trigger lives inside `.panel`, which sets `overflow: hidden`. Before the portal fix the
 * menu opened correctly in the DOM but was invisible on screen, which is exactly the kind of bug a
 * unit test cannot see. This drives the real UI and measures the rendered rectangle.
 *
 *   FATE_SHOT_URL=http://localhost:5199/preview.html npx electron scripts/check-export-menu.mjs
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
      const trigger = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Export'));
      if (!trigger) return { error: 'no Export button' };

      trigger.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const menu = document.querySelector('.menu__list');
      if (!menu) return { error: 'menu did not render' };

      const box = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);

      // Walk ancestors looking for an overflow clip that would hide it.
      let clippedBy = null;
      for (let el = menu.parentElement; el && el !== document.body; el = el.parentElement) {
        const ov = getComputedStyle(el).overflow;
        if (ov !== 'visible') { clippedBy = el.className || el.tagName; break; }
      }

      // Is the menu's own box actually inside the viewport, and is the topmost element at its
      // centre the menu itself (i.e. nothing is painted over it)?
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const atPoint = document.elementFromPoint(cx, cy);

      return {
        parentIsBody: menu.parentElement === document.body,
        position: style.position,
        width: Math.round(box.width), height: Math.round(box.height),
        left: Math.round(box.left), top: Math.round(box.top),
        insideViewport: box.left >= 0 && box.top >= 0 &&
          box.right <= window.innerWidth && box.bottom <= window.innerHeight,
        clippedByAncestor: clippedBy,
        topmostAtCentreIsMenu: !!atPoint && menu.contains(atPoint),
        itemCount: menu.querySelectorAll('.menu__item').length,
      };
    })()`);

    console.log(JSON.stringify(result, null, 2));
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(`FAILED: ${error?.message ?? error}`);
    app.exit(1);
  });
