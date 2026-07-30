/**
 * Phase-0 screenshot harness: boots the arena on a replay fixture in
 * headless Chromium and captures the three fixed SHOT_POSES camera angles
 * (src/game/cameraRig.ts) into docs/screens/shot-N.png.
 *
 * Usage:
 *   npm run shots               idle-rest fixture, shots 1..3
 *   npm run shots -- flame-fan  any synthetic fixture name
 *   SHOT_SUFFIX=before npm run shots   writes shot-N-before.png
 *
 * Requires a dev server on :5173 (starts one itself if absent). Waits for
 * the arena's __FB_READY flag (90 rendered frames) before capturing, so
 * lighting and first particles are settled and runs are comparable.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const OUT_DIR = new URL('../docs/screens/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const FIXTURE = process.argv[2] ?? 'idle-rest';
const SUFFIX = process.env.SHOT_SUFFIX ? `-${process.env.SHOT_SUFFIX}` : '';
const SHOTS = [1, 2, 3];

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
    for (const n of SHOTS) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const url = `${BASE}/?screen=arena&replay=${FIXTURE}&shot=${n}`;
      await page.goto(url);
      await page.waitForFunction(
        () => (window as unknown as { __FB_READY?: boolean }).__FB_READY === true,
        undefined,
        { timeout: 30_000 },
      );
      const path = `${OUT_DIR}shot-${n}${SUFFIX}.png`;
      await page.screenshot({ path });
      console.log(`captured ${path}  (${url})`);
      await page.close();
    }
  } finally {
    await browser.close();
    dev?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
