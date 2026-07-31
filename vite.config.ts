/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
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
