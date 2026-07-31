/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    // The game bundle builds ONLY index.html. studio.html (the recording
    // studio, `npm run studio`) is a dev-server page and must never ship
    // in the game build.
    rollupOptions: {
      input: 'index.html',
    },
  },
  worker: {
    // The pose worker dynamically imports @mediapipe/tasks-vision, which
    // code-splits; the default iife worker format cannot code-split.
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
