import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the advisories this tree has already been patched for.
 *
 * The repo's own gate is `npm audit --omit=dev`, which was clean on the
 * previous pins both times the advisory database moved under us (not the
 * lockfile). A green audit therefore says nothing about *how far below* the
 * patched version a future re-pin may go, and `npm install <old-version>` does
 * not trip any test. These floors make a downgrade fail loudly instead.
 *
 *   next 16.0.0 - 16.4.0          GHSA-2464-fhr4-w9xw (unauth RCE in the image
 *                                  optimizer with SVG), GHSA-p3m5-59mp-jv5r
 *                                  (App Router Server Actions DoS),
 *                                  GHSA-673q-mjm6-r5xr (`use cache` typed-array RCE)
 *   @sentry/nextjs 10.0.0-alpha.0 - 10.75.1
 *                                  GHSA-mchm-gjx6-7h55 (middleware bypass when
 *                                  the tunnel route is enabled)
 *
 * 2026-10-24 (pass 45) — all three were patch bumps inside their current major,
 * so the production tree stays audit-clean without a behavioural change:
 *
 *   nodemailer 3.0.0 - 10.1.3     GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w,
 *                                  GHSA-85x2-q946-cp5h — three addressparser
 *                                  header-injection flavours. The app only
 *                                  mails zod-validated addresses, but the
 *                                  sender/reply-to parser is shared with every
 *                                  future call site, and 10.1.4 is a no-op bump.
 *   undici 8.0.0 - 8.12.1         GHSA-xjj6-f33q-929c (a malicious server's
 *                                  >5 content-codings crashes the process via
 *                                  an orphaned stream), GHSA-4qv8-2p9j-2685
 *                                  (EventSource DoS), GHSA-f72v-6w45-q472 (SRI
 *                                  bypass). fetchPublicBuffer/analyzeImage/
 *                                  postWebhook all fetch provider- or
 *                                  operator-chosen URLs through this package,
 *                                  so the transport itself is in the threat model.
 *   zod < 4.6.6                   GHSA-mrhx-c7xc-m3w5 (unbounded per-element
 *                                  issue accumulation turns a large array into
 *                                  memory exhaustion). Fixed in v4; the tree is
 *                                  now on v4 (tsc + the full suite verified the
 *                                  migration — the schemas only use the classic
 *                                  string/number/enum/object surface).
 *
 * 2026-10-31 — two moderate advisories in the BUILD-TIME half of the Sentry
 * integration, five production-scope hits, none of them runtime-reachable:
 *
 *   glob 3.0.0 - 14.0.1   GHSA-3g3m-2fjr-6pw4 (AbortSignal cancellation bypass,
 *                         post-timeout filesystem traversal); reached through
 *                         @sentry/nextjs → @sentry/bundler-plugins, which uses
 *                         it to enumerate build artifacts for sourcemap upload.
 *   minimatch < 11.0.1    GHSA-g3hv-75wg-m249 (globparts amplification DoS);
 *                         reached through glob's own dependency.
 *
 *  Both ride on glob, and no Sentry release (10.x or 11.x) has moved off glob
 *  13 yet, so the fix is a SCOPED override — a global one would re-resolve the
 *  test/ESLint toolchains' glob too. glob 14's manifest requires
 *  minimatch ^11.0.2, so patching the parent patches both.
 */
const FLOORS: Record<string, string> = {
  next: "16.4.1",
  "@sentry/nextjs": "10.75.2",
  nodemailer: "10.1.4",
  undici: "8.12.2",
  zod: "4.6.6",
};

/**
 * Advisories in packages none of our direct dependencies declares.
 *
 * These cannot live in FLOORS: there is no manifest range to raise, so the
 * floor is held by an `overrides` entry in package.json. `npm audit --omit=dev`
 * also flags them the day the advisory lands (that is how qs was found in pass
 * 49), but a lockfile regenerated against an older mirror — or a hand-edited
 * pin — would float below the patched version with every gate green.
 *
 *   qs 6.7.0 - 6.16.0   GHSA-6pq8-jhm2-2vcw — qs.stringify with arrayFormat
 *                       "comma" throws on an element carrying a non-callable
 *                       own toString (CWE-248 uncaught exception, DoS).
 *                       Reached through stripe@17.7.0 (its query encoder), not
 *                       directly; 6.17.0 is the patch.
 *   glob 3.0.0 - 14.0.1 GHSA-3g3m-2fjr-6pw4 — the patched 14.0.2 also pulls
 *                       minimatch ^11.0.2, which clears GHSA-g3hv-75wg-m249
 *                       (minimatch < 11.0.1) transitively.
 */
const TRANSITIVE_FLOORS: Record<string, string> = {
  qs: "6.17.0",
  glob: "14.0.2",
};

/**
 * Overrides that must be SCOPED rather than global.
 *
 * A top-level `glob` override would re-resolve every glob in the tree,
 * including the dev/test toolchains' copies; the advisory is in Sentry's
 * build-time bundler plugin, so the override names that parent. Scoping is
 * also what keeps the assertion honest: the test reads the same nested entry
 * the resolver does.
 */
const OVERRIDE_SCOPES: Record<string, string> = {
  glob: "@sentry/bundler-plugins",
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
type PackageJson = {
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string | Record<string, string>>;
};

const root = process.cwd();

describe("dependency floors for published advisories", () => {
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

  it("holds transitive advisories above their floors through overrides", () => {
    for (const [name, floor] of Object.entries(TRANSITIVE_FLOORS)) {
      const manifest = readJson<Manifest>(join(root, "node_modules", name, "package.json"));
      expect(compare(manifest.version, floor), `${name}@${manifest.version} < ${floor}`).toBeGreaterThanOrEqual(0);
      // The installed tree being clean is not enough: the override is what keeps
      // a regenerated lockfile from resolving back down to the advisory range.
      // A transitive package the resolver only meets under one parent is scoped
      // there (OVERRIDE_SCOPES), so the entry is read from the same place npm
      // does rather than assuming the top level.
      const scope = OVERRIDE_SCOPES[name];
      const scoped = scope ? pkg.overrides?.[scope] : undefined;
      const override = scope
        ? (typeof scoped === "object" ? scoped : undefined)?.[name]
        : pkg.overrides?.[name];
      expect(
        override,
        `${name} has no ${scope ? `${scope}-scoped ` : ""}overrides entry, so a fresh resolve need not stay patched`,
      ).toBeTruthy();
      expect(compare(override as string, floor), `${name} override "${override}" < ${floor}`).toBeGreaterThanOrEqual(0);
    }
  });
});
