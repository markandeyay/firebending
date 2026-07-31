/**
 * Title-screen screenshot harness: loads the live title flow in headless
 * Chromium and captures docs/screens/title-<tag>.png for design iteration.
 *
 * Usage:
 *   npx tsx tools/titleshot.ts v1          writes docs/screens/title-v1.png
 *   npx tsx tools/titleshot.ts v2 1600 900 custom viewport
 *
 * Requires a dev server on :5173 (starts one itself if absent). Waits for
 * the .fb-title layer plus a short settle so the ember column is visible.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const OUT_DIR = new URL('../docs/screens/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const TAG = process.argv[2] ?? 'v1';
const WIDTH = Number.parseInt(process.argv[3] ?? '1440', 10) || 1440;
const HEIGHT = Number.parseInt(process.argv[4] ?? '810', 10) || 810;

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let dev: ChildProcess | null = null;
  if (!(await serverUp())) {
    console.log('starting vite dev server...');
    dev = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
      shell: true,
      stdio: 'ignore',
    });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await serverUp()) break;
      if (i === 39) throw new Error('dev server never came up on :5173');
    }
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.fb-title', { timeout: 15000 });
    // TITLE_HOVER=1 parks the pointer on the first menu item so the ink
    // underline hover state is visible in the capture.
    if (process.env.TITLE_HOVER === '1') {
      await page.hover('.fb-menu-item');
    }
    // Let the ember column drift into frame.
    await page.waitForTimeout(1400);
    const out = `${OUT_DIR}title-${TAG}.png`;
    await page.screenshot({ path: out });
    console.log(`captured ${out} (${WIDTH}x${HEIGHT})`);
  } finally {
    await browser.close();
    dev?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
