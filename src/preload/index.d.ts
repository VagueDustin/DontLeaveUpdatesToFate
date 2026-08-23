import type { FateApi } from './index.js';

declare global {
  interface Window {
    fate: FateApi;
  }
}

export {};
