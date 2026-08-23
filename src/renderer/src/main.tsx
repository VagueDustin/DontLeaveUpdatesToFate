/**
 * main.tsx — renderer entry.
 *
 * Fonts are self-hosted through @fontsource rather than loaded from Google's CDN: a packaged build
 * runs from `file://` with a CSP that forbids external origins, and an installed app has to look
 * right offline. Only the variable builds are imported, which covers every weight the brand uses
 * (Cinzel 700/900 for display, Inter 400–800 for UI) from one file each.
 */

import '@fontsource-variable/cinzel';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import './styles/brand/tokens.css';
import './styles/brand/utilities.css';
import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initialise, toast } from './state/index.js';

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing from index.html.');

const root = createRoot(container);

/**
 * Render only once the first state has arrived.
 *
 * Painting an empty shell and then filling it in produces a visible two-step flash on every launch;
 * waiting for the initial IPC round trip (a few milliseconds) means the first frame is the real one.
 */
initialise()
  .catch((error: unknown) => {
    // Render anyway — a failed handshake should still show a usable window with a visible reason.
    console.error('Failed to load the initial state', error);
  })
  .finally(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  toast('error', `Something went wrong: ${reason}`);
});
