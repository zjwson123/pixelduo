import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// Pass 49 — the artifact the advisory gate does not measure.
//
// `npm audit --omit=dev` is the gate that certifies "the runtime tree is clean",
// and it is a statement about the LOCKFILE's production scope. The worker /
// scripts image is built from the deps stage's FULL `npm ci`, because tsx and the
// Prisma CLI are devDependencies that the deployed commands nonetheless execute
// (`npx tsx scripts/worker.ts`, `npx prisma migrate deploy`). That stage carried
// the entire test toolchain into the image operators push to a registry and are
// told to keep old tags of — 207 packages where the web image has 24, including
// vitest + tinypool (2 critical, prototype-pollution → RCE) and vite (8 more
// advisories) at the pins this lockfile holds. None of them appears in the
// production scope the gate reads, so every gate was green on an artifact that
// shipped them (probed: `docker run --rm pd-ci-worker` listed vitest, vite,
// tinypool, playwright, typescript, prisma).
//
// The fix is a `runtime-deps` stage that strips the test/report toolchain, with
// the worker stage copying THAT filesystem — not deleting after the copy, which
// would leave the packages in an earlier layer that `docker save` hands over
// (the trap the web/worker comments already describe). These assertions pin the
// three files that have to agree: the stage's removal list, the two image gates,
// and the two tools the image actually executes.

const REPO = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

const GATES = [".github/workflows/ci.yml", "scripts/ci-local.sh"];

/** The body of the runtime-deps stage, from its FROM to the next stage. */
function runtimeDepsStage(dockerfile: string): string {
  const start = dockerfile.indexOf("FROM deps AS runtime-deps");
  expect(start, "Dockerfile has no runtime-deps stage").toBeGreaterThan(0);
  const next = dockerfile.indexOf("\nFROM ", start + 1);
  return next === -1 ? dockerfile.slice(start) : dockerfile.slice(start, next);
}

/** Package names the stage's `rm -rf` list removes. */
function removedPackages(stage: string): string[] {
  const run = stage.indexOf("RUN rm -rf");
  expect(run, "runtime-deps has no `RUN rm -rf`").toBeGreaterThan(0);
  const names = [...stage.slice(run).matchAll(/node_modules\/(@?[A-Za-z0-9._-]+)/g)].map(
    (m) => m[1],
  );
  return [...new Set(names)];
}

describe("pass 49 — the shipped worker artifact does not carry the test toolchain", () => {
  it("the worker stage copies the stripped dependency tree, not the deps stage", () => {
    const dockerfile = read("Dockerfile");
    const workerStart = dockerfile.indexOf("FROM node:24-alpine AS worker");
    expect(workerStart, "Dockerfile has no worker stage").toBeGreaterThan(0);
    const worker = dockerfile.slice(workerStart);
    expect(worker).toContain(
      "COPY --from=runtime-deps --chown=node:node /app/node_modules ./node_modules",
    );
    // The pre-pass-49 shape. A revert here re-ships every advisory the strip was
    // added to remove, with the audit gate still green (it reads the lockfile).
    expect(worker).not.toContain("COPY --from=deps --chown=node:node /app/node_modules");
  });

  it("strips the test/report toolchain and keeps the two tools the image runs", () => {
    const removed = removedPackages(runtimeDepsStage(read("Dockerfile")));
    for (const name of ["vitest", "@vitest", "vite", "vite-node", "tinypool", "playwright", "playwright-core", "@playwright"]) {
      expect(removed, `runtime-deps must remove ${name}`).toContain(name);
    }
    // `npx tsx` IS the worker/rollover entrypoint; `npx prisma migrate deploy`
    // is the migrate service. A removal list that grows to cover them breaks the
    // deploy, and the boot smoke is the only thing that would notice.
    expect(removed).not.toContain("tsx");
    expect(removed).not.toContain("prisma");
  });

  it("both image gates assert every removed name, and assert the tools survive", () => {
    const removed = removedPackages(runtimeDepsStage(read("Dockerfile")));
    for (const gate of GATES) {
      const src = read(gate);
      for (const name of removed) {
        expect(src, `${gate} does not assert /app/node_modules/${name} is absent`).toContain(
          `test ! -e /app/node_modules/${name}`,
        );
      }
      // The assertion is only worth having if what it protects still works.
      expect(src, gate).toContain("test -e /app/node_modules/tsx");
      expect(src, gate).toContain("test -x /app/node_modules/.bin/prisma");
    }
  });

  it("every absence assertion in the gates names a package the stage removes", () => {
    // The other direction: a gate that asserts an absence nothing enforces is
    // the vacuous-gate shape passes 33/34/37 kept finding. An assertion on a
    // name the Dockerfile does not remove is either dead or mis-scoped.
    const removed = new Set(removedPackages(runtimeDepsStage(read("Dockerfile"))));
    for (const gate of GATES) {
      const src = read(gate);
      const asserted = [...src.matchAll(/test ! -e \/app\/node_modules\/(@?[A-Za-z0-9._-]+)/g)].map(
        (m) => m[1],
      );
      expect(asserted.length, `${gate} asserts no node_modules absence`).toBeGreaterThan(0);
      for (const name of asserted) {
        expect(removed.has(name), `${gate} asserts ${name} absent but the Dockerfile keeps it`).toBe(
          true,
        );
      }
    }
  });

  it("the advisory gate and the strip still cover each other's blind spot", () => {
    // `npm audit --omit=dev` cannot see the dev tree, and the strip is why that
    // no longer matters for the artifact. If the audit invocation is dropped,
    // the production tree loses its only gate; if the strip's stage is dropped,
    // the artifact loses its only bound. Pin both as a pair.
    for (const gate of GATES) {
      expect(read(gate), gate).toContain("npm audit --omit=dev");
    }
    expect(read("Dockerfile")).toContain("FROM deps AS runtime-deps");
  });

  it("the ORM every runtime module imports is declared a RUNTIME dependency", () => {
    // The same scope question one level down: `npm audit --omit=dev` and any
    // future `npm ci --omit=dev` read package.json's dependency section, and
    // @prisma/client was declared under devDependencies while lib/prisma.ts and
    // lib/queue.ts import it at runtime. "The production tree is audit-clean"
    // therefore excluded the ORM the whole app runs on — no advisory today, but
    // the gate would not have seen one.
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies["@prisma/client"]).toBeTruthy();
    expect(pkg.devDependencies?.["@prisma/client"]).toBeUndefined();
  });
});
