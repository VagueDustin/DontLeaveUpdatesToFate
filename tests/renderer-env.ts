/**
 * renderer-env.ts: the minimum browser surface the renderer's state module touches on import, so
 * components can be rendered to static markup in Node. Import it before any renderer module.
 */

const noop = (): void => undefined;
const media = { matches: false, addEventListener: noop, removeEventListener: noop };

(globalThis as unknown as { window: unknown }).window = {
  matchMedia: () => media,
  addEventListener: noop,
  removeEventListener: noop,
  fate: new Proxy({}, { get: () => new Proxy(() => Promise.resolve(null), { get: () => () => Promise.resolve(null) }) }),
};
(globalThis as unknown as { document: unknown }).document ??= {
  documentElement: { dataset: {}, setAttribute: noop, removeAttribute: noop },
};
