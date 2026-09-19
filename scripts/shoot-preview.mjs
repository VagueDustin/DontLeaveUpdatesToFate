/**
 * shoot-preview.mjs: screenshot each harness state with Electron.
 *
 * Run through Electron rather than a headless browser so the captures come from the same Chromium
 * build the app ships with, a font-rendering or backdrop-filter difference between engines would make
 * the screenshots misleading.
 *
 * Requires `node scripts/preview-server.mjs` to be running.
 *
 *   FATE_SHOT_DIR=<dir> npx electron scripts/shoot-preview.mjs
 *
 * The output directory comes from the environment, not argv: Electron parses its own switches out of
 * argv and swallows a bare `--`, so an argv-passed path arrives inconsistently.
 */

import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.env.FATE_SHOT_DIR;
const BASE = process.env.FATE_SHOT_URL ?? 'http://localhost:5199/preview.html';
const STATES = (process.env.FATE_SHOT_STATES ?? 'running,finished,settings,update,empty').split(',');

app.disableHardwareAcceleration();
// Capture at 1:1 regardless of the display running the harness. Without this a 125% display produces
// a 1751px PNG of a 1400px window, which is both larger than it needs to be and inconsistent between
// machines, and these captures end up in the README.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.on('window-all-closed', () => app.quit());

app
  .whenReady()
  .then(async () => {
    if (!OUT) throw new Error('FATE_SHOT_DIR is not set.');
    await mkdir(OUT, { recursive: true });

    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      frame: false,
    });

    for (const state of STATES) {
      const url = `${BASE}?state=${state}`;
      console.log(`loading ${url}`);
      await window.loadURL(url);
      // Let web fonts and the backdrop-filter compositing settle; without a beat here the first
      // capture shows fallback serif metrics instead of Cinzel.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      /*
        Settle the entry animations before capturing.
        An offscreen window throttles animation ticks, so a 0.16s entry animation can still be at
        opacity 0 seconds later and the capture silently shows an element that is not there. Switching
        to the app own reduced-motion path puts every animation at its end state, so what is captured
        is the shipped UI at rest rather than a frame part-way through a transition that never runs.
      */
      await window.webContents.executeJavaScript(
        "document.documentElement.dataset.motion = 'off'",
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      const image = await window.webContents.capturePage();
      const file = join(OUT, `preview-${state}.png`);
      await writeFile(file, image.toPNG());
      console.log(`captured ${state} -> ${file}`);
    }

    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(`FAILED: ${error?.message ?? error}`);
    app.exit(1);
  });
