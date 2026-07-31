/**
 * Recording-studio entry point (studio.html). A separate Vite page from the
 * game: `npm run studio` serves it on port 5205; `vite build` does NOT
 * include it (the build input is index.html only), so no studio code ever
 * reaches the game bundle.
 */

import { StudioApp } from './app';
import '../ui/theme.css';
import './studio.css';

const root = document.getElementById('studio');
if (!root) throw new Error('Missing #studio root');

void StudioApp.create(root).catch((err: unknown) => {
  console.warn('studio failed to boot', err);
  root.textContent = 'The studio failed to boot. Check the console and reload.';
});
