/**
 * Fixture generator script (T002). Run with:
 *   npx tsx fixtures/generate.ts
 *
 * Writes one LandmarkRecording JSON per fixture into fixtures/synthetic/.
 * Output is deterministic: every fixture uses a seeded PRNG derived from its
 * label, so re-running produces byte-identical files.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { buildAllRecordings } from './specs';

const outDir = new URL('./synthetic/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const recordings = buildAllRecordings();
for (const rec of recordings) {
  const file = new URL(`./synthetic/${rec.label}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(rec));
  console.log(`wrote fixtures/synthetic/${rec.label}.json (${rec.frames.length} frames)`);
}
console.log(`Generated ${recordings.length} fixtures at 30 fps.`);
