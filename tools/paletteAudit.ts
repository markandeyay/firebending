/**
 * Palette audit (Round 3 Phase 6, spec Section 9): loads each final station
 * screenshot (docs/screens/station-N.png), extracts the 8 dominant color
 * clusters via k-means, and FLAGS any cluster outside the allowed Section 9
 * families:
 *
 *   charcoal-dark    near-neutral warm darks (deep shadow, timber, void)
 *   oxblood/vermllon red-orange hues 0-30 deg (cloth, lacquer, lit timber)
 *   fire-glow        bright warm 10-55 deg (coals, flames, lantern cores --
 *                    fire is the ONLY saturation)
 *   antique-gold     35-50 deg, muted (trim, banner band)
 *   tan/parchment    low-sat warm (floor planks, stone, paper)
 *
 * Anything cool (hue 60..345 with real saturation) or any saturated color
 * outside those bands is a FLAG. Exit code 1 when any shot flags.
 *
 * Decode strategy: the PNGs are drawn onto a canvas inside headless
 * Chromium (no PNG decoder dependency in node); k-means runs in-page and
 * only the 8 clusters come back.
 *
 * Usage: npx tsx tools/paletteAudit.ts [suffix]
 *   suffix e.g. "p6before" audits station-N-p6before.png instead.
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT_DIR = new URL('../docs/screens/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const SUFFIX = process.argv[2] ? `-${process.argv[2]}` : '';
const SHOTS = [1, 2, 3, 4, 5, 6];
const K = 8;

interface Cluster {
  r: number;
  g: number;
  b: number;
  share: number;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l };
}

/** Section 9 family classification. Returns the family name or 'FLAG'. */
export function classify(h: number, s: number, l: number): string {
  const warmHue = h <= 60 || h >= 345;
  // Near-neutral warm darks: deep shadow floor of the whole palette.
  if (l <= 0.16 && (s <= 0.3 || (warmHue && s <= 0.85))) return 'charcoal-dark';
  // Cool anything is an instant flag (no blue/cyan/green ever).
  if (!warmHue && s > 0.12) return 'FLAG';
  if (!warmHue) return 'neutral-gray';
  // Fire glow: the only permitted saturation, bright warm cores and halos.
  if (h >= 10 && h <= 55 && l >= 0.55) return 'fire-glow';
  // Red-orange family, 0-30 deg (oxblood, vermilion, lit timber, embers).
  if (h <= 30 || h >= 345) return 'oxblood/vermilion';
  // Muted antique gold trim band.
  if (h > 30 && h <= 50 && s <= 0.7) return 'antique-gold';
  // Tan / parchment: low-sat warm midtones.
  if (h > 30 && h <= 60 && s <= 0.45) return 'tan/parchment';
  return 'FLAG';
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let anyFlag = false;

  console.log('Palette audit (Section 9) -- 8 dominant clusters per shot');
  console.log(
    'shot        | hex     | share  | H    S    L    | family',
  );
  console.log('-'.repeat(72));

  for (const n of SHOTS) {
    const file = `${OUT_DIR}station-${n}${SUFFIX}.png`;
    const b64 = readFileSync(file).toString('base64');
    const clusters = (await page.evaluate(async (dataUrl: string) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;

      // Sample every 3rd pixel per axis; plenty for dominant clusters.
      const samples: number[][] = [];
      for (let y = 0; y < img.height; y += 3) {
        for (let x = 0; x < img.width; x += 3) {
          const i = (y * img.width + x) * 4;
          samples.push([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]);
        }
      }

      // k-means, k=8, deterministic init spread across the sample list.
      const k = 8;
      const centers: number[][] = [];
      for (let c = 0; c < k; c++) {
        const s = samples[Math.floor((c + 0.5) * (samples.length / k))] ?? [0, 0, 0];
        centers.push([...s]);
      }
      const counts = new Array<number>(k).fill(0);
      const assign = new Int32Array(samples.length);
      for (let iter = 0; iter < 14; iter++) {
        counts.fill(0);
        const sums: number[][] = Array.from({ length: k }, () => [0, 0, 0]);
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i]!;
          let best = 0;
          let bestD = Infinity;
          for (let c = 0; c < k; c++) {
            const ctr = centers[c]!;
            const dr = s[0]! - ctr[0]!;
            const dg = s[1]! - ctr[1]!;
            const db = s[2]! - ctr[2]!;
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
          assign[i] = best;
          counts[best] = (counts[best] ?? 0) + 1;
          const sum = sums[best]!;
          sum[0] += s[0]!;
          sum[1] += s[1]!;
          sum[2] += s[2]!;
        }
        for (let c = 0; c < k; c++) {
          if ((counts[c] ?? 0) > 0) {
            const sum = sums[c]!;
            centers[c] = [
              sum[0]! / counts[c]!,
              sum[1]! / counts[c]!,
              sum[2]! / counts[c]!,
            ];
          }
        }
      }
      const total = samples.length;
      return centers
        .map((ctr, c) => ({
          r: Math.round(ctr[0]!),
          g: Math.round(ctr[1]!),
          b: Math.round(ctr[2]!),
          share: (counts[c] ?? 0) / total,
        }))
        .sort((a, b) => b.share - a.share);
    }, `data:image/png;base64,${b64}`)) as Cluster[];

    for (const cl of clusters) {
      const { h, s, l } = rgbToHsl(cl.r, cl.g, cl.b);
      const family = classify(h, s, l);
      const flag = family === 'FLAG';
      if (flag && cl.share >= 0.005) anyFlag = true;
      const hex = `#${((1 << 24) | (cl.r << 16) | (cl.g << 8) | cl.b)
        .toString(16)
        .slice(1)}`;
      console.log(
        `station-${n}${SUFFIX.padEnd(2)} | ${hex} | ${(cl.share * 100)
          .toFixed(1)
          .padStart(5)}% | ${h.toFixed(0).padStart(3)}  ${s
          .toFixed(2)
          .slice(1)}  ${l.toFixed(2).slice(1)}  | ${family}${flag ? '  <-- FLAG' : ''}`,
      );
    }
    console.log('-'.repeat(72));
  }

  await browser.close();
  if (anyFlag) {
    console.error('PALETTE AUDIT: FLAGS FOUND');
    process.exit(1);
  }
  console.log('PALETTE AUDIT: clean');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
