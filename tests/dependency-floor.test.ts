import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the two critical advisories published on 2026-10-23.
 *
 * The repo's own gate is `npm audit --omit=dev`, which was clean on the
 * previous pins — the advisory database changed under us, not the lockfile.
 * A green audit therefore says nothing about *how far below* the patched
 * version a future re-pin may go, and `npm install <old-version>` does not
 * trip any test. These floors make a downgrade fail loudly instead.
 *
 *   next 16.0.0 - 16.4.0          GHSA-2464-fhr4-w9xw (unauth RCE in the image
 *                                  optimizer with SVG), GHSA-p3m5-59mp-jv5r
 *                                  (App Router Server Actions DoS),
 *                                  GHSA-673q-mjm6-r5xr (`use cache` typed-array RCE)
 *   @sentry/nextjs 10.0.0-alpha.0 - 10.75.1
 *                                  GHSA-mchm-gjx6-7h55 (middleware bypass when
 *                                  the tunnel route is enabled)
 */
const FLOORS: Record<string, string> = {
  next: "16.4.1",
  "@sentry/nextjs": "10.75.2",
};

function numericParts(version: string): number[] {
  const cleaned = version.replace(/^[^\d]*/, "").split("-")[0];
  return cleaned.split(".").map((part) => Number(part) || 0);
}

/** Compares dotted numeric versions; a prerelease sorts below its release. */
function compare(a: string, b: string): number {
  const left = numericParts(a);
  const right = numericParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  const leftPre = a.includes("-");
  const rightPre = b.includes("-");
  if (leftPre !== rightPre) return leftPre ? -1 : 1;
  return 0;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type Manifest = { version: string };
type PackageJson = { dependencies: Record<string, string>; devDependencies?: Record<string, string> };

const root = process.cwd();

describe("dependency floors for the 2026-10-23 critical advisories", () => {
  const pkg = readJson<PackageJson>(join(root, "package.json"));

  it("installs a patched version of every affected package", () => {
    for (const [name, floor] of Object.entries(FLOORS)) {
      const manifest = readJson<Manifest>(join(root, "node_modules", name, "package.json"));
      expect(compare(manifest.version, floor), `${name}@${manifest.version} < ${floor}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps dependency ranges above the floors so a lockfile-less install stays patched", () => {
    for (const [name, floor] of Object.entries(FLOORS)) {
      const range = pkg.dependencies[name] ?? pkg.devDependencies?.[name];
      expect(range, `${name} is not a dependency at all`).toBeTruthy();
      // ^16.4.3 / ~16.4.3 / >=16.4.1 / 16.4.3 all declare their own floor first.
      expect(compare(range as string, floor), `${name} range "${range}" < ${floor}`).toBeGreaterThanOrEqual(0);
    }
  });
});
