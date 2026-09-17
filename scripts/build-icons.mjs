/**
 * build-icons.mjs — derive every raster icon from `resources/icon.svg`.
 *
 * Per @vaguedustin/brand docs/CONSUMING.md: don't improvise icon sizes, derive them all from one
 * source in `brand/`, and record what was derived and where it's used. That table is below.
 *
 * Uses ImageMagick (`magick`) rather than `sharp`, so the icon pipeline is not a build-time native
 * dependency of the app itself. Run it only when the SVG changes; the outputs are committed.
 *
 *   icon.ico        16,24,32,48,64,128,256   window + taskbar + installer + Explorer
 *   icon.png        512                      electron-builder's Linux/general fallback
 *   installer.bmp   164x314                  NSIS welcome page sidebar
 *   header.bmp      150x57                   NSIS header strip
 */

import { execFile } from 'node:child_process';
import { mkdir, access, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVG = join(ROOT, 'resources', 'icon.svg');
const SVG_SMALL = join(ROOT, 'resources', 'icon-small.svg');
const OUT = join(ROOT, 'resources');
const BUILD = join(ROOT, 'build');

/** ICO members. 256 is the largest Windows reads from an .ico; 16 and 32 do the most work. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Below this, the full mark's three nested shapes land within a pixel of each other and smear.
 * Those sizes come from the simplified source instead — the standard practice for a real icon set.
 */
const SMALL_CUTOFF = 48;

async function magick(args) {
  try {
    return await run('magick', args, { windowsHide: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'ImageMagick is not on PATH. Install it with: winget install ImageMagick.ImageMagick',
      );
    }
    throw new Error(`magick ${args.join(' ')}\n${error.stderr || error.message}`);
  }
}

/**
 * Rasterise at an explicit density.
 *
 * Without `-density`, ImageMagick renders the SVG at its intrinsic size and then resamples, which
 * blurs the hairlines badly at 16 and 32px. Rendering at the target size directly keeps them crisp.
 */
async function rasterise(size, target, source = SVG) {
  await magick([
    '-background',
    'none',
    '-density',
    String(size * 2),
    source,
    '-resize',
    `${size}x${size}`,
    '-strip',
    target,
  ]);
}

async function main() {
  await access(SVG);
  await access(SVG_SMALL);
  await mkdir(OUT, { recursive: true });
  await mkdir(BUILD, { recursive: true });

  const temps = [];
  for (const size of ICO_SIZES) {
    const target = join(OUT, `.icon-${size}.png`);
    await rasterise(size, target, size < SMALL_CUTOFF ? SVG_SMALL : SVG);
    temps.push(target);
  }

  // One .ico holding every size, so Windows picks the right one per context.
  await magick([...temps, join(OUT, 'icon.ico')]);
  await rasterise(512, join(OUT, 'icon.png'));

  // NSIS installer art. BMP3 with no alpha — NSIS renders anything else as garbage.
  await magick([
    '-background',
    '#070B1A',
    '-density',
    '600',
    SVG,
    '-resize',
    '132x132',
    '-gravity',
    'center',
    '-extent',
    '164x314',
    '-alpha',
    'remove',
    '-alpha',
    'off',
    '-type',
    'TrueColor',
    `BMP3:${join(BUILD, 'installerSidebar.bmp')}`,
  ]);

  await magick([
    '-background',
    '#070B1A',
    '-density',
    '300',
    SVG,
    '-resize',
    '44x44',
    '-gravity',
    'east',
    '-extent',
    '150x57',
    '-alpha',
    'remove',
    '-alpha',
    'off',
    '-type',
    'TrueColor',
    `BMP3:${join(BUILD, 'installerHeader.bmp')}`,
  ]);

  // `rm` rather than `cmd /c del`. These paths are built from the repo’s own location, so there
  // was never anything dangerous in them — but handing a path to a shell to delete a file Node can
  // delete itself is a command line nobody needed to build, and it is one more thing that breaks if
  // the checkout ever sits somewhere with a space or an ampersand in the name.
  await Promise.all(temps.map((file) => rm(file, { force: true })));

  const small = ICO_SIZES.filter((s) => s < SMALL_CUTOFF);
  const large = ICO_SIZES.filter((s) => s >= SMALL_CUTOFF);
  console.log(`icon.ico          ${ICO_SIZES.join(', ')}`);
  console.log(`  from icon-small.svg  ${small.join(', ')}`);
  console.log(`  from icon.svg        ${large.join(', ')}`);
  console.log('icon.png          512');
  console.log('installerSidebar  164x314');
  console.log('installerHeader   150x57');
}

main().catch((error) => {
  console.error(error.message);
process.exitCode = 1;
});
