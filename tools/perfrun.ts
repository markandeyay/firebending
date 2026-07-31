/**
 * Unattended perf-gate runner. Headless Chromium does not occlusion-throttle
 * rAF (a visible-tab requirement that killed unattended runs in the user's
 * browser), and with ANGLE/D3D11 flags it can reach the real GPU on Windows,
 * so the numbers are representative when `gpu: true` appears in the output.
 *
 * Usage:
 *   npx tsx tools/perfrun.ts            plain gate
 *   npx tsx tools/perfrun.ts ml         gate with the MediaPipe models
 *                                       (hand + pose LITE)
 *   npx tsx tools/perfrun.ts ml full    same, pose FULL variant (&pose=full)
 *
 * Prints the PERFGATE json result and exits 0 on PASS, 1 on FAIL/timeout.
 */

import { chromium } from 'playwright';

const ML = process.argv[2] === 'ml';
const POSE_FULL = process.argv[3] === 'full';
const BASE = 'http://localhost:5173';

async function main(): Promise<void> {
  const browser = await chromium.launch({
    // Real GPU in headless on Windows; falls back to SwiftShader silently
    // if unavailable (detectable via the reported gl renderer).
    args: ['--use-angle=d3d11', '--enable-unsafe-webgpu', '--enable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));

  await page.goto(
    `${BASE}/?debug=perf${ML ? '&ml=1' : ''}${ML && POSE_FULL ? '&pose=full' : ''}`,
  );

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked';
  });
  const gpu = !/swiftshader|software/i.test(renderer);
  console.log(`gl renderer: ${renderer}  (gpu: ${gpu})`);

  // Warmup 3s + measure 15s + ML model loads; generous ceiling.
  const result = await page
    .waitForFunction(
      () => (window as unknown as { __perfGateResult?: unknown }).__perfGateResult,
      undefined,
      { timeout: 240_000 },
    )
    .then(() => page.evaluate(() => (window as unknown as { __perfGateResult?: unknown }).__perfGateResult));

  console.log('PERFGATE', JSON.stringify(result, null, 2));
  await browser.close();
  const pass = (result as { pass?: boolean } | undefined)?.pass === true;
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
