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
 *   npx tsx tools/perfrun.ts rates      end-to-end LIVE pipeline rates
 *                                       against the fake-device camera
 *
 * Gate modes print the PERFGATE json result and exit 0 on PASS, 1 on
 * FAIL/timeout.
 *
 * RATES MODE (quality round Phase 1): launches with
 * --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream so
 * getUserMedia yields Chromium's synthetic camera, boots ?debug=rates (the
 * real LiveLandmarkSource + arena, no calibration flow), lets it run
 * RATES_MEASURE_MS, then prints the measured table from the page's
 * __FB_RATES hook. IMPORTANT LABEL: the fake feed contains NO PERSON, so
 * every model runs its full-search detector path every frame -- the
 * inference costs printed are the WORST-CASE NO-SUBJECT numbers. The
 * RATES and decoupling measurements (cameraHz, handHz, poseHz, renderHz,
 * photon-to-emit, main-thread ML ms) are valid: they show the pipeline
 * keeps its cadence even under worst-case model cost.
 */

import { chromium } from 'playwright';

const MODE = process.argv[2] ?? 'gate';
const POSE_FULL = process.argv[3] === 'full';
const BASE = 'http://localhost:5173';

/** How long the rates probe runs before sampling (~20 s of steady state). */
const RATES_MEASURE_MS = 20_000;

const GPU_ARGS = ['--use-angle=d3d11', '--enable-unsafe-webgpu', '--enable-gpu'];
const FAKE_CAMERA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

interface Pcts {
  p50: number;
  p95: number;
  count: number;
}

interface RatesReport {
  cameraHz: Pcts;
  handHz: Pcts;
  poseHz: Pcts;
  renderHz: Pcts;
  photonToEmitMs: Pcts;
  photonToFireMs: Pcts;
  mainMlMs: number;
  workerHandDetectMs: number;
  workerPoseDetectMs: number;
  handWorkerActive: boolean;
  poseWorkerActive: boolean;
}

async function gpuBanner(page: import('playwright').Page): Promise<boolean> {
  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked';
  });
  const gpu = !/swiftshader|software/i.test(renderer);
  console.log(`gl renderer: ${renderer}  (gpu: ${gpu})`);
  return gpu;
}

async function runGate(): Promise<void> {
  const ml = MODE === 'ml';
  const browser = await chromium.launch({ args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));

  await page.goto(
    `${BASE}/?debug=perf${ml ? '&ml=1' : ''}${ml && POSE_FULL ? '&pose=full' : ''}`,
  );
  await gpuBanner(page);

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

function fmtPcts(p: Pcts, unit: string): string {
  if (p.count === 0) return '- (no samples)';
  return `${p.p50.toFixed(1)}/${p.p95.toFixed(1)} ${unit}  (n=${p.count})`;
}

async function runRates(): Promise<void> {
  const browser = await chromium.launch({
    args: [...GPU_ARGS, ...FAKE_CAMERA_ARGS],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') {
      console.log(`[page ${m.type()}]`, m.text().slice(0, 200));
    }
  });

  await page.goto(`${BASE}/?debug=rates`);
  await gpuBanner(page);

  // The arena installs __FB_RATES once it has entered (models loaded, live
  // source running). Model downloads can be slow on cold cache.
  await page.waitForFunction(
    () => typeof (window as unknown as { __FB_RATES?: unknown }).__FB_RATES === 'function',
    undefined,
    { timeout: 240_000 },
  );
  console.log(`arena live; measuring for ${(RATES_MEASURE_MS / 1000).toFixed(0)}s...`);
  await page.waitForTimeout(RATES_MEASURE_MS);

  const report = (await page.evaluate(() =>
    (window as unknown as { __FB_RATES: () => unknown }).__FB_RATES(),
  )) as RatesReport | null;
  await browser.close();

  if (!report) {
    console.error('rates probe returned null (live source not probed?)');
    process.exit(1);
  }

  console.log('');
  console.log('RATES (live pipeline, fake-device camera)');
  console.log('NOTE: the synthetic feed contains NO PERSON, so hand/pose');
  console.log('inference costs below are WORST-CASE NO-SUBJECT (full-search');
  console.log('detector every frame). Rates and decoupling ARE valid.');
  console.log('');
  const rows: Array<[string, string]> = [
    ['cameraHz p50/p95', fmtPcts(report.cameraHz, 'Hz')],
    ['handHz p50/p95', fmtPcts(report.handHz, 'Hz')],
    ['poseHz p50/p95', fmtPcts(report.poseHz, 'Hz')],
    ['renderHz p50/p95', fmtPcts(report.renderHz, 'Hz')],
    ['photonToEmit p50/p95', fmtPcts(report.photonToEmitMs, 'ms')],
    ['photonToFire p50/p95', fmtPcts(report.photonToFireMs, 'ms')],
    ['main-thread ML ms/frame', report.mainMlMs.toFixed(2)],
    ['worker hand detect ms', report.workerHandDetectMs.toFixed(2)],
    ['worker pose detect ms', report.workerPoseDetectMs.toFixed(2)],
    ['hand worker active', String(report.handWorkerActive)],
    ['pose worker active', String(report.poseWorkerActive)],
  ];
  const pad = Math.max(...rows.map(([k]) => k.length)) + 2;
  for (const [k, v] of rows) console.log(`  ${k.padEnd(pad)}${v}`);
  console.log('');
  console.log('RATES_JSON', JSON.stringify(report));
  process.exit(0);
}

async function main(): Promise<void> {
  if (MODE === 'rates') return runRates();
  return runGate();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
