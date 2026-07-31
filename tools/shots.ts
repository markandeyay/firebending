/**
 * Screenshot harness: boots the arena on a replay fixture in headless
 * Chromium and captures the six fixed SHOT_POSES camera angles -- the six
 * authored combat-station poses (src/game/cameraRig.ts) -- into
 * docs/screens/station-N.png.
 *
 * Usage:
 *   npm run shots               idle-rest fixture, stations 1..6
 *   npm run shots -- flame-fan  any synthetic fixture name
 *   SHOT_SUFFIX=before npm run shots   writes station-N-before.png
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
const SHOTS = [1, 2, 3, 4, 5, 6];
/** SHOT_BARE=1 drops gloves/PIP/HUD for clean environment hero shots. */
const BARE = process.env.SHOT_BARE === '1' ? '&bare=1' : '';
/** SHOT_DELAY_MS waits after the ready flag before capturing (fire timing). */
const DELAY_MS = Number.parseInt(process.env.SHOT_DELAY_MS ?? '0', 10) || 0;
/** SHOT_ONLY limits capture to one pose index (e.g. SHOT_ONLY=1). */
const ONLY = Number.parseInt(process.env.SHOT_ONLY ?? '0', 10) || 0;

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
      if (ONLY !== 0 && n !== ONLY) continue;
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[shot-${n}] console.error:`, m.text());
      });
      page.on('pageerror', (e) => console.error(`[shot-${n}] pageerror:`, String(e)));
      const url = `${BASE}/?screen=arena&replay=${FIXTURE}&shot=${n}${BARE}`;
      await page.goto(url);
      const path = `${OUT_DIR}station-${n}${SUFFIX}.png`;
      try {
        await page.waitForFunction(
          () => (window as unknown as { __FB_READY?: boolean }).__FB_READY === true,
          undefined,
          { timeout: 60_000 },
        );
      } catch {
        // Capture anyway so the failure mode is visible, then flag it.
        await page.screenshot({ path: `${OUT_DIR}station-${n}${SUFFIX}-timeout.png` });
        console.error(`station-${n}: __FB_READY never set; wrote diagnostic capture`);
        await page.close();
        continue;
      }
      if (DELAY_MS > 0) await page.waitForTimeout(DELAY_MS);
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
