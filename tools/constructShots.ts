/**
 * Construct damage-stage screenshot harness (final P4): boots the arena on
 * the idle-rest fixture at one station pose and captures the SAME construct
 * at 0%, 50%, 90% damage and after death (debris settled), driving damage
 * through the window.__FB_DAMAGE debug hook (screens/arena.ts).
 *
 * Usage:
 *   npx tsx tools/constructShots.ts          station pose 1 (variant 0)
 *   npx tsx tools/constructShots.ts 3        station pose 3 (variant 2)
 *
 * Writes docs/screens/construct-0.png / -50.png / -90.png / -death.png.
 * Requires a dev server on :5173 (starts one itself if absent).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const PORT = process.env.SHOT_PORT ?? '5173';
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = new URL('../docs/screens/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const SHOT = Number.parseInt(process.argv[2] ?? '1', 10) || 1;
const SUFFIX = process.env.SHOT_SUFFIX ? `-${process.env.SHOT_SUFFIX}` : '';

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function setDamage(page: Page, pct: number): Promise<void> {
  await page.evaluate((p) => {
    (window as unknown as { __FB_DAMAGE?: (pct: number) => void }).__FB_DAMAGE?.(p);
  }, pct);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  let dev: ChildProcess | null = null;
  if (!(await serverUp())) {
    console.log('starting vite dev server...');
    dev = spawn('npx', ['vite', '--port', PORT, '--strictPort'], {
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('pageerror:', String(e)));
    await page.goto(`${BASE}/?screen=arena&replay=idle-rest&shot=${SHOT}&bare=1`);
    await page.waitForFunction(
      () => (window as unknown as { __FB_READY?: boolean }).__FB_READY === true,
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT_DIR}construct-0${SUFFIX}.png` });
    console.log('captured construct-0');

    await setDamage(page, 50);
    await page.waitForTimeout(1200); // let the wobble settle, smoke is off at 50
    await page.screenshot({ path: `${OUT_DIR}construct-50${SUFFIX}.png` });
    console.log('captured construct-50');

    await setDamage(page, 90);
    await page.waitForTimeout(2200); // smoke puffs need a beat to rise
    await page.screenshot({ path: `${OUT_DIR}construct-90${SUFFIX}.png` });
    console.log('captured construct-90');

    await setDamage(page, 100);
    await page.waitForTimeout(900); // kill ember burst + parts in flight
    await page.screenshot({ path: `${OUT_DIR}construct-death${SUFFIX}.png` });
    console.log('captured construct-death');

    await page.waitForTimeout(6000); // slow-mo ends, debris settles
    await page.screenshot({ path: `${OUT_DIR}construct-settled${SUFFIX}.png` });
    console.log('captured construct-settled');
    await page.close();
  } finally {
    await browser.close();
    dev?.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
