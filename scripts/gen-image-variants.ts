#!/usr/bin/env tsx
/**
 * Build-time generator for the landing page's image variants.
 *
 * Why pre-generate and commit rather than transform at runtime: this repo self-hosts
 * (docker compose + Caddy) with no platform image service available, and these images
 * are the landing page's single largest cost — 1.9MB of the 2.38MB first screen, with
 * the LCP being case1.jpg's 634KB original. Generated once, committed, baked into the
 * image: zero runtime cost and reproducible.
 *
 * The crop is visually free because the CSS already crops the same way: .compare,
 * .mq-item and .how-cell img all use object-fit: cover over a fixed aspect-ratio, so
 * the region a user sees IS the centre crop we are baking in — this just stops
 * shipping the pixels that were never visible.
 *   hero    .compare      aspect-ratio: 4 / 4.4
 *   marquee .mq-item      aspect-ratio: 4 / 5
 *   how     .how-cell img aspect-ratio: 16 / 10
 *
 * Usage: npx tsx scripts/gen-image-variants.ts [--force]
 *   Regenerates only what is missing or older than its source, so it is safe to run
 *   as part of a build.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type Slot = { name: string; aspect: number; widths: number[]; quality: number };

// Widths are the measured rendering width rounded UP to the next rung — see
// perf/基线.md: hero 641px (the max-width 1360 layout at a 1440 viewport),
// marquee 280px, how 391px. The 1x rung is deliberately one step above the box
// (641 -> 720, not 640): a 641px box with a 640px candidate would fall back to the
// 2x file at DPR1 and waste the whole point. */
const SLOTS: Slot[] = [
  // The hero's 2x rung stops at 960, not 1440: case1.jpg is only 941px wide (case225
  // just 600) while the 641px box wants 1282 device px at DPR2. The sources are the
  // limit, so a 1440 rung is pure interpolation costing an extra 224KB.
  { name: "hero", aspect: 4 / 4.4, widths: [720, 960], quality: 78 },
  { name: "mq", aspect: 4 / 5, widths: [320, 640], quality: 76 },
  { name: "how", aspect: 16 / 10, widths: [420, 840], quality: 76 },
];

// What the landing page actually renders: 2 hero (the compare slider), 10 marquee, 3 how.
const HERO = [1, 225];
const MARQUEE = [1, 338, 373, 390, 355, 383, 166, 396, 225, 402];
const HOW = [6, 338, 402];

const SRC_DIR = "public/showcase";

function jobsFor(): Array<{ slot: Slot; n: number }> {
  const jobs: Array<{ slot: Slot; n: number }> = [];
  const bySlot: Record<string, number[]> = { hero: HERO, mq: MARQUEE, how: HOW };
  for (const slot of SLOTS) {
    for (const n of bySlot[slot.name]) jobs.push({ slot, n });
  }
  // One variant per image per slot: the marquee renders its list twice for the loop.
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const k = `${j.slot.name}-${j.n}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  const force = process.argv.includes("--force");
  await mkdir(SRC_DIR, { recursive: true });
  let generated = 0;
  let reused = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const { slot, n } of jobsFor()) {
    const src = `${SRC_DIR}/case${n}.jpg`;
    const srcStat = await stat(src);
    const srcBytes = srcStat.size;

    for (const width of slot.widths) {
      const height = Math.round(width / slot.aspect);
      const out = `${SRC_DIR}/case${n}-${slot.name}-${width}.webp`;
      let fresh = false;
      try {
        const o = await stat(out);
        fresh = o.mtimeMs >= srcStat.mtimeMs && !force;
      } catch {
        fresh = false;
      }
      if (fresh) {
        reused++;
        continue;
      }
      const buf = await sharp(await readFile(src))
        .resize({ width, height, fit: "cover", position: "centre" })
        .webp({ quality: slot.quality, effort: 5 })
        .toBuffer();
      await writeFile(out, buf);
      generated++;
    }

    // Print the 1x rung against the source: that is what a first visit downloads.
    const oneX = `${SRC_DIR}/case${n}-${slot.name}-${slot.widths[0]}.webp`;
    const after = (await stat(oneX)).size;
    console.log(
      `${src} ${(srcBytes / 1024).toFixed(0)}KB → ${path.basename(oneX)} ${(after / 1024).toFixed(0)}KB`,
    );
  }

  console.log(`\n${generated} variants generated, ${reused} reused (--force to regenerate all)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
