/**
 * scrollbar.ts - publish the scrollbar's width as a CSS variable.
 *
 * WHY THIS EXISTS. The package table's header sits outside the scroller and its rows inside it. Both
 * are capped to the same reading width and centred, so they only line up if their containers are the
 * same width, and the scroller's container is narrower by exactly one scrollbar. Running the real app
 * maximized on a 3840px display, that put the header 4px right of its own rows: small, and precisely
 * the kind of misregistration that makes a data table feel sloppy.
 *
 * It cannot be a constant. Chromium's scrollbar width differs between platforms and changes when
 * Windows switches between classic and overlay scrollbars, so the only honest number is a measured
 * one. Measured once at startup, and again when the display scale changes, which is the one event
 * that alters it without a reload.
 */

/** Measure by comparing a box that scrolls against the space its content actually gets. */
function measure(): number {
  const outer = document.createElement('div');
  outer.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(outer);
  const width = outer.offsetWidth - outer.clientWidth;
  outer.remove();
  return width;
}

export function publishScrollbarWidth(): void {
  const apply = (): void => {
    document.documentElement.style.setProperty('--sb-w', `${measure()}px`);
  };

  apply();

  // A move between displays of different scale changes the device pixel ratio, and with it the
  // scrollbar's CSS width. `resolution` is the media feature that fires on exactly that.
  const dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dpr.addEventListener('change', apply, { once: true });
}
