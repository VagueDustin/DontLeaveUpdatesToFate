/**
 * build-icns.mjs: the macOS app icon, `resources/icon.icns`, from the same master as every other icon.
 *
 * macOS only: it uses the system's `swift`, `sips` and `iconutil`, so it needs nothing installed.
 * scripts/mac-icon.swift renders the master art into Apple's squircle on the 1024px icon grid, with a
 * gold rim along the edge, and every size iconutil expects is written from that one canvas.
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

// One 1024 canvas on Apple's grid: the art in the macOS squircle, gold rim, soft shadow.
const canvas = join(work, 'canvas.png');
execFileSync('swift', [join(ROOT, 'scripts', 'mac-icon.swift'), MASTER, canvas], { stdio: 'ignore' });

for (const size of [16, 32, 128, 256, 512]) {
  sips('-z', String(size), String(size), canvas, '--out', join(iconset, `icon_${size}x${size}.png`));
  sips('-z', String(size * 2), String(size * 2), canvas, '--out', join(iconset, `icon_${size}x${size}@2x.png`));
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', OUT]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
