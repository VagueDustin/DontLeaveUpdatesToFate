/**
 * shoot-preview.mjs — screenshot each harness state with Electron.
 *
 * Run through Electron rather than a headless browser so the captures come from the same Chromium
 * build the app ships with — a font-rendering or backdrop-filter difference between engines would make
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
