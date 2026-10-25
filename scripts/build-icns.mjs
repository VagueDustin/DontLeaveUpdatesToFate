/**
 * build-icns.mjs: the macOS app icon, `resources/icon.icns`, from the same master as every other icon.
 *
 * macOS only: it uses the system's `sips` and `iconutil`, so it needs nothing installed. The master is
 * already a rounded square on transparency, so it is scaled to Apple's icon grid (the body at about 86%
 * of the canvas, centred) and every size iconutil expects is written from that one padded canvas.
 *
 * Run with `npm run icons:mac`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MASTER = join(ROOT, 'resources', 'new-icon.png');
const OUT = join(ROOT, 'resources', 'icon.icns');

if (process.platform !== 'darwin') {
  console.error('build-icns.mjs needs macOS (sips and iconutil).');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'dlutf-icns-'));
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset);

const sips = (...args) => execFileSync('/usr/bin/sips', args, { stdio: 'ignore' });

// One 1024 canvas with the body at 880px, centred, transparent around it.
const canvas = join(work, 'canvas.png');
sips('-z', '880', '880', MASTER, '--out', canvas);
sips('--padToHeightWidth', '1024', '1024', canvas);

for (const size of [16, 32, 128, 256, 512]) {
  sips('-z', String(size), String(size), canvas, '--out', join(iconset, `icon_${size}x${size}.png`));
  sips('-z', String(size * 2), String(size * 2), canvas, '--out', join(iconset, `icon_${size}x${size}@2x.png`));
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', OUT]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
