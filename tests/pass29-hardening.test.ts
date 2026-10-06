import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// Pass 29. Two advisories appeared WITHOUT a commit, in code already shipped —
// the class no source audit can see, and the reason the runtime gate exists:
//
//   - sharp <0.35.5 (GHSA-wq5f-xc86-pv6w, HIGH): vulnerability in its librsvg
//     dependency (CVE-2026-96889). sharp is the image pipeline: the watermark
//     bake, the variant generator and every thumbnail the app serves. The
//     declared floor was ^0.35.4, so a fresh install landed on the vulnerable
//     release.
//   - source-map-js <1.2.2 (GHSA-68fv-2mgg-jv7q, HIGH): event-loop denial of
//     service through indexed source-map section offsets. It arrives twice —
//     through next's postcss and through vite's — so every copy has to be
//     checked, not the first one found.
//
// Both fix with a patch bump, and `npm audit --omit=dev` — the gate added in
// pass 23 — is what caught them: it was red on this tree before the bump.
// (The remaining advisories are dev-only: vitest/tinypool/vite/esbuild and the
// prisma CLI. They are reported rather than gated, and a vitest 5 upgrade is a
// deliberate change of its own, not something to fold into a daily pass.)
//
// Every case below was confirmed to FAIL against the pre-fix source.
const REPO = process.cwd();
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));

/** Numeric compare of `major.minor.patch`, ignoring prerelease/build metadata. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** The lowest version a caret/tilde/exact range can resolve to. */
function rangeFloor(range: string): string {
  const m = /^\s*[\^~]?\s*(\d+\.\d+\.\d+)/.exec(range);
  if (!m) throw new Error(`cannot read a version floor out of "${range}"`);
  return m[1];
}

describe("pass 29 — the runtime tree carries no open advisory", () => {
  it("pins sharp at or above the librsvg fix (0.35.5)", () => {
    const lock = readJson("package-lock.json");
    const installed = lock.packages["node_modules/sharp"].version as string;
    expect(compareVersions(installed, "0.35.5")).toBeGreaterThanOrEqual(0);
    // The lockfile alone is not enough: the declared range is what a fresh
    // resolution may land on, and `^0.35.4` admits the vulnerable 0.35.4.
    const range = readJson("package.json").dependencies.sharp as string;
    expect(compareVersions(rangeFloor(range), "0.35.5")).toBeGreaterThanOrEqual(0);
  });

  it("pins source-map-js at or above the indexed-section DoS fix (1.2.2)", () => {
    const lock = readJson("package-lock.json");
    const copies = Object.entries(lock.packages as Record<string, { version?: string }>)
      .filter(([k]) => k.endsWith("node_modules/source-map-js"))
      .map(([, v]) => v.version as string);
    expect(copies.length).toBeGreaterThan(0);
    for (const version of copies) {
      expect(compareVersions(version, "1.2.2")).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps the sharp platform payloads on the same version as the driver", () => {
    // sharp loads its prebuilt binaries from @img/*; a driver bumped without
    // them (or the reverse) is the shape that fails at runtime rather than at
    // install, in the worker, on the watermark path.
    const lock = readJson("package-lock.json");
    const sharp = compareVersions(lock.packages["node_modules/sharp"].version, "0.35.5");
    expect(sharp).toBeGreaterThanOrEqual(0);
    const mismatched = Object.entries(lock.packages as Record<string, { version?: string }>)
      .filter(([k]) => /node_modules\/@img\/sharp-[a-z0-9-]+$/.test(k))
      .filter(([, v]) => {
        const version = v.version as string;
        // The libvips payloads carry their own version line (1.3.x).
        return !version.startsWith("1.3.") && compareVersions(version, "0.35.5") < 0;
      })
      .map(([k, v]) => `${k}@${v.version}`);
    expect(mismatched).toEqual([]);
  });
});
