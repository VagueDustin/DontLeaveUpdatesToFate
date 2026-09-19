/**
 * build-icons.mjs: derive every raster icon from the two sources in `resources/`.
 *
 * Per @vaguedustin/brand docs/CONSUMING.md: don't improvise icon sizes, derive them all from one
 * source, and record what was derived and where it's used. That table is below.
 *
 * TWO SOURCES, AND THE CUTOFF BETWEEN THEM IS MEASURED RATHER THAN GUESSED.
 *
 * `new-icon.png` is the master mark: a gold compass-star inside a broken refresh ring on a navy
 * squircle, at 1254px. Rendered down it holds beautifully to 32px and then falls apart, at 24px the
 * arrowheads have gone and at 16px the eight-point star is a three-pixel blob, so the whole thing
 * reads as "a gold ring with a smudge in it". I rendered the ladder and looked at it rather than
 * assuming a number.
 *
 * So 16 and 24 come from `icon-small.svg`, which is not a smaller copy of the master but a redrawn
 * one: the tile edge and the ring survive, the star drops from eight points to four, and the
 * arrowheads and sparkles are gone entirely. Same read (gold ring, gold star, navy field) at the
 * only fidelity those sizes can carry.
 *
 * Uses ImageMagick (`magick`) rather than `sharp`, so the icon pipeline is not a build-time native
 * dependency of the app itself. Run it when either source changes; the outputs are committed.
 *
 *   icon.ico          16,24,32,48,64,128,256   window + taskbar + installer + Explorer
 *   icon.png          512                      electron-builder's Linux/general fallback
 *   installerSidebar  164x314                  NSIS welcome page sidebar
 *   installerHeader   150x57                   NSIS header strip
 *   build/appx/*      7 assets                 MSIX tiles, store logo and splash
 *   docs/brand/       640 + 1280x640           README header and GitHub social preview
 */

import { execFile } from 'node:child_process';
import { mkdir, access, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The master mark. A raster, because that is how it was drawn. */
const MASTER = join(ROOT, 'resources', 'new-icon.png');
const SVG_SMALL = join(ROOT, 'resources', 'icon-small.svg');
const OUT = join(ROOT, 'resources');
const BUILD = join(ROOT, 'build');
const APPX = join(BUILD, 'appx');
/** The wordmarked emblem. Marketing artwork, not a UI asset, it never ships inside the app. */
const HERO = join(ROOT, 'resources', 'software-hero-image.png');
const BRAND_OUT = join(ROOT, 'docs', 'brand');

/** The house navy, for the surfaces that cannot carry transparency. */
const NAVY = '#0A0E27';
/** The deepest surface, for the GitHub social canvas. */
const SURFACE_BASE = '#070B1A';

/** ICO members. 256 is the largest Windows reads from an .ico; 16 and 32 do the most work. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Below this, the master's ring, arrowheads and eight-point star land within a pixel of each other
 * and smear into one gold mass. Those sizes come from the redrawn source instead.
 *
 * 32 rather than 48 because I rendered both and compared: at 32 the master still resolves its ring,
 * its arrowheads and a clean four-point centre, so handing 32 to the simplified mark would be giving
 * up detail the size can actually hold.
 */
const SMALL_CUTOFF = 32;

/**
 * The MSIX asset set. electron-builder's appx target requires the first four and recognises the last
 * two; it resolves them from `build/appx/` via directories.buildResources.
 *
 * The two non-square tiles letterbox the mark on navy rather than stretching it, the mark is a
 * squircle and a 2:1 tile is not, and `appx.showNameOnTiles` stays false because the wordmark is
 * already carried by the hero artwork elsewhere.
 */
const APPX_ASSETS = [
  { name: 'Square44x44Logo', w: 44, h: 44 },
  { name: 'Square71x71Logo', w: 71, h: 71 },
  { name: 'Square150x150Logo', w: 150, h: 150 },
  { name: 'Square310x310Logo', w: 310, h: 310 },
  { name: 'StoreLogo', w: 50, h: 50 },
  { name: 'Wide310x150Logo', w: 310, h: 150, fit: 132 },
  { name: 'SplashScreen', w: 620, h: 300, fit: 260 },
];

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
 * Rasterise one size from whichever source suits it.
 *
 * The two paths are genuinely different operations and neither substitutes for the other:
 *
 * SVG: render at an explicit density. Without `-density` ImageMagick draws the SVG at its intrinsic
 * size and then resamples, which blurs the hairlines badly at 16 and 24px. Drawing at the target
 * size directly keeps them crisp.
 *
 * PNG: downsample with Lanczos, then a light unsharp. Reducing a 1254px master by 39x to reach 32px
 * is where detail goes soft; Lanczos keeps the most of it and the unsharp pass puts back the edge
 * definition the reduction costs. The numbers are restrained on purpose, a heavier mask haloes the
 * gold against the navy, which is exactly the size where that would be most visible.
 */
async function rasterise(size, target, source = MASTER) {
  const isSvg = source.endsWith('.svg');
  await magick(
    isSvg
      ? ['-background', 'none', '-density', String(size * 2), source, '-resize', `${size}x${size}`, '-strip', target]
      : [source, '-filter', 'Lanczos', '-resize', `${size}x${size}`, '-unsharp', '0x0.6+0.6+0.01', '-strip', target],
  );
}

/**
 * One MSIX asset: the mark, optionally letterboxed onto navy.
 *
 * A square asset lets the mark fill the tile, because it already carries its own navy field and gold
 * edge. A non-square one cannot, so `fit` says how large the mark is drawn before the canvas is
 * extended around it, rather than distorting a squircle into a rectangle.
 */
async function appxAsset({ name, w, h, fit }) {
  const target = join(APPX, `${name}.png`);
  const square = w === h;
  await magick([
    MASTER,
    '-filter',
    'Lanczos',
    '-resize',
    square ? `${w}x${h}` : `${fit}x${fit}`,
    '-unsharp',
    '0x0.5+0.5+0.01',
    ...(square ? [] : ['-background', NAVY, '-gravity', 'center', '-extent', `${w}x${h}`]),
    '-strip',
    target,
  ]);
  return `${name}.png`.padEnd(22) + `${w}x${h}`;
}

async function main() {
  await access(MASTER);
  await access(SVG_SMALL);
  await mkdir(OUT, { recursive: true });
  await mkdir(BUILD, { recursive: true });
  await mkdir(APPX, { recursive: true });

  const temps = [];
  for (const size of ICO_SIZES) {
    const target = join(OUT, `.icon-${size}.png`);
    await rasterise(size, target, size < SMALL_CUTOFF ? SVG_SMALL : MASTER);
    temps.push(target);
  }

  // One .ico holding every size, so Windows picks the right one per context.
  await magick([...temps, join(OUT, 'icon.ico')]);
  await rasterise(512, join(OUT, 'icon.png'));

  // NSIS installer art. BMP3 with no alpha, NSIS renders anything else as garbage.
  await magick([
    '-background',
    NAVY,
    MASTER,
    '-filter',
    'Lanczos',
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
    NAVY,
    MASTER,
    '-filter',
    'Lanczos',
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
  // was never anything dangerous in them, but handing a path to a shell to delete a file Node can
  // delete itself is a command line nobody needed to build, and it is one more thing that breaks if
  // the checkout ever sits somewhere with a space or an ampersand in the name.
  await Promise.all(temps.map((file) => rm(file, { force: true })));

  // MSIX tiles. Sequential rather than Promise.all: seven concurrent ImageMagick processes each
  // decoding the same 1.7MB master is a lot of memory to save perhaps a second.
  const appx = [];
  for (const asset of APPX_ASSETS) appx.push(await appxAsset(asset));

  /*
    The hero derivatives.

    Generated here rather than by hand so they are reproducible from the master, which is the same
    reason every other raster in this repo is. The master is 1254px and 1.8MB, far too heavy to put
    at the top of a README, and GitHub's social-preview upload has its own ceiling, so both
    derivatives are 8-bit and maximally deflated.

    The social preview is 1280x640 because that is the canvas GitHub renders; the emblem is square,
    so it is letterboxed on the house navy rather than stretched.
  */
  await mkdir(BRAND_OUT, { recursive: true });
  await magick([
    HERO, '-filter', 'Lanczos', '-resize', '640x640',
    '-depth', '8', '-define', 'png:compression-level=9', '-strip',
    join(BRAND_OUT, 'hero.png'),
  ]);
  await magick([
    HERO, '-filter', 'Lanczos', '-resize', '420x420',
    '-background', SURFACE_BASE, '-gravity', 'center', '-extent', '1280x640',
    '-depth', '8', '-define', 'png:compression-level=9', '-strip',
    join(BRAND_OUT, 'social-preview.png'),
  ]);

  const small = ICO_SIZES.filter((s) => s < SMALL_CUTOFF);
  const large = ICO_SIZES.filter((s) => s >= SMALL_CUTOFF);
  console.log(`icon.ico              ${ICO_SIZES.join(', ')}`);
  console.log(`  from icon-small.svg  ${small.join(', ')}`);
  console.log(`  from new-icon.png    ${large.join(', ')}`);
  console.log('icon.png              512');
  console.log('installerSidebar      164x314');
  console.log('installerHeader       150x57');
  console.log('build/appx/');
  for (const line of appx) console.log(`  ${line}`);
  console.log('docs/brand/');
  console.log('  hero.png              640x640');
  console.log('  social-preview.png    1280x640');
}

main().catch((error) => {
  console.error(error.message);
process.exitCode = 1;
});
