// Remove build-host-only files from the Next standalone artifact, after every
// build.
//
// `next build` copies the project's `.env` (and `.env.production`, `.env.local`)
// into `.next/standalone/` unconditionally, so that `node server.js` from that
// directory picks up local configuration. On a build host that is exactly the
// leak: the artifact carries NEXTAUTH_SECRET, DATABASE_URL and the S3 keys in
// cleartext, and a deploy that ships the standalone tree (or a registry image
// built from it, which is why the Dockerfile prunes the same files) hands them
// out with it.
//
// The same walk also removes local SQLite databases. The tracing step copies the
// whole `prisma/` directory into the standalone output, and that directory holds
// whatever the developer's machine has there: `prisma/dev.db` and
// `prisma/test.db` — user rows with bcrypt hashes, orders, ledger entries — were
// measured inside an artifact built on this host (151 KB each). `.dockerignore`
// covers `*.db` for the image path, but a host that rsyncs `.next/standalone`
// (the non-Docker deploy docs/deploy.md describes) had nothing standing in the
// way, and this script's scope was the reason: it looked only for dotenv files.
// A Postgres deployment never reads them; they are dev fixtures.
//
// The Docker path deletes both classes in its image stages. This is the same
// guard for every path that is NOT Docker, run from the `postbuild` script so a
// plain `npm run build` cannot leave them behind either.
//
// Deleting is safe: nothing in the standalone tree reads a dotenv file or a
// SQLite database at runtime once it is gone — and since pass 38 that is
// enforced, not assumed: the Prisma client the tree carries was the one reader
// (see neuterPrismaDotenv below), and the prune now rewrites its env-path
// config as well as deleting the files. Every deployed configuration passes its
// environment explicitly — docker compose, or the host's own process
// environment.
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import os from "node:os";
import { neuterPrismaDotenv } from "./prisma-dotenv.mjs";

// Optional root argument so a test can point this at a scratch tree — but only
// the real artifact or a scratch directory under the OS temp dir (pass 39). The
// script deletes recursively; an invocation with $HOME or / would remove
// credentials and databases outside any build tree.
//
// The containment test is on the REAL path (pass 61). `resolve()` only
// normalises `..`; it follows neither symlinks nor an intermediate link. A
// scratch argument such as /tmp/scratch that is itself a symlink to / passed
// `startsWith(tempRoot)` and the walk then deleted `.env`/`*.db` through it and
// `rmSync(root/app)` removed /app — the exact destructive shape the guard was
// added for. The lexical path may not be a symlink, and the resolved root must
// still be the artifact or under the resolved temp root.
const lexical = resolve(process.argv[2] ?? ".next/standalone");
const allowedStandalone = resolve(".next/standalone");
const tempRoot = realpathSync(os.tmpdir());
let root = lexical;
try {
  if (lstatSync(lexical).isSymbolicLink()) {
    console.error(`[prune-standalone] refusing to prune ${lexical} — the root itself is a symlink`);
    process.exit(1);
  }
  root = realpathSync(lexical);
} catch {
  // A missing artifact (an interrupted build) is not a reason to fail; walk()
  // is a no-op and the build-host leak gates are the authority on the result.
}
let allowedReal = allowedStandalone;
try {
  allowedReal = realpathSync(allowedStandalone);
} catch {
  // Not built yet.
}
if (root !== allowedReal && !root.startsWith(tempRoot + sep)) {
  console.error(
    `[prune-standalone] refusing to prune ${root} — the root must be .next/standalone or a directory under ${tempRoot}`,
  );
  process.exit(1);
}
const removed = [];

function buildHostOnly(name) {
  return (
    /^\.env(\.|$)/.test(name) ||
    /\.(db|db-journal|sqlite|sqlite3)$/.test(name)
  );
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no standalone output (e.g. a build that was interrupted)
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue; // a dependency's own .env is not ours
      walk(p);
    } else if (buildHostOnly(entry.name)) {
      // Measure BEFORE the unlink. This log line is the only evidence the guard
      // ran at all, and it used to stat the path after rmSync had already
      // removed it: the catch branch returned 0, so every run printed
      // "(0 bytes)" — indistinguishable from having deleted an empty
      // placeholder rather than the build host's real .env (NEXTAUTH_SECRET,
      // DATABASE_URL, the S3 keys) or its local user database. The removal was
      // correct; the report of it was not, and that report is what an operator
      // audits.
      let size = 0;
      try {
        size = statSync(p).size;
      } catch {
        // Raced away between readdir and stat; nothing to measure.
      }
      rmSync(p, { force: true });
      removed.push({ path: p, size });
    }
  }
}

walk(root);

// The removal report comes FIRST, and the order is load-bearing: CI's build
// job and scripts/ci-local.sh both read `grep -m1 '[prune-standalone]'` and
// require that first line to say what was REMOVED — it is their only evidence
// the planted .env reached the tree. Printing anything else on the line before
// it turns that gate into "the prune reported no removals … so it proved
// nothing", which is exactly how this change's first pipeline run failed (pass
// 38). Reports, in the order the gates read them.
if (removed.length) {
  const size = removed.reduce((a, r) => a + r.size, 0);
  console.log(
    `[prune-standalone] removed ${removed.length} build-host-only file(s) from ${root} (${size} bytes): ${removed.map((r) => r.path).join(", ")}`,
  );
} else {
  console.log(`[prune-standalone] no build-host-only files in ${root}`);
}

// The Docker web stage prunes these exact top-level names from the artifact —
// and a NON-Docker deployment ships `.next/standalone` itself (docs/deploy.md's
// documented path). The build leaves the whole source tree, the design
// prototypes, internal monetisation notes and the deploy files inside it, so
// that artifact carried the same material the image deliberately refuses
// (pass 39). `public/`, `prisma/schema.prisma`, `node_modules/`, `.next/`,
// `server.js` and `package.json` are what actually runs and are kept.
const SHIP_EXCLUDES = [
  "app",
  "components",
  "lib",
  "scripts",
  "designs",
  "docs",
  "tests",
  "e2e",
  "perf",
  "backups",
  "data",
  "PRODUCT_OUTLINE.md",
  "README.md",
  "docker-compose.yml",
  "docker-compose.single.yml",
  "docker-compose.prod.yml",
  "Caddyfile",
  "Dockerfile",
  "next.config.mjs",
  "proxy.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "vitest.config.ts",
  "vitest.setup.ts",
  "playwright.config.ts",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "next-env.d.ts",
  ".github",
  ".npmrc",
  ".gitignore",
  ".dockerignore",
  ".vscode",
  ".idea",
  ".claude",
  ".cursor",
  ".env.example",
  "prisma/seed.ts",
];
const excluded = [];
for (const name of SHIP_EXCLUDES) {
  const p = join(root, name);
  try {
    if (statSync(p, { throwIfNoEntry: false })) {
      rmSync(p, { recursive: true, force: true });
      excluded.push(name);
    }
  } catch {
    // A path that vanished (or cannot be read) is not a reason to fail the
    // build; the artifact assertions in CI are the authority on the result.
  }
}
if (excluded.length) {
  console.log(
    `[prune-standalone] removed ${excluded.length} non-runtime entr(ies) from the artifact: ${excluded.join(", ")}`,
  );
}

// The one runtime reader of a dotenv file, closed (pass 38).
//
// Deleting `.next/standalone/.env` is not enough on its own, and this script's
// own claim — "nothing in the standalone tree reads a dotenv file at runtime" —
// was false while the generated Prisma client sat in the tree: its config
// carries `"relativeEnvPaths": { "schemaEnvPath": "../../../.env" }`, resolved
// against the client's OWN directory, so every process that imports it loads
// `<tree>/.env` into process.env (probed: a planted .env's DATABASE_URL,
// NEXTAUTH_SECRET and PAYMENT_ALLOW_MOCK appeared in the environment of a bare
// `require()` of the artifact's client, no server involved). The file is gone
// after the prune, but it comes back — a pre-prune backup restored, an rsync of
// a tree built without postbuild, an old dev `.env` kept next to the artifact —
// and docs/deploy.md told the operator such a file configures nothing. Worse
// than a stale config: PAYMENT_ALLOW_MOCK=1 from that file sets
// instrumentation.ts's `testDeployment`, which is the flag that accepts the
// CI-published NEXTAUTH_SECRET and skips the NEXTAUTH_URL/SMTP_URL boot gates,
// so a stray dotenv could satisfy a signing key anyone can read out of the
// public repository. Rewriting the paths to null makes the claim true and the
// file inert. Fail closed if the shape is unrecognised (scripts/prisma-dotenv.mjs,
// shared with the Docker worker stage — pass 39).
const prismaEnv = neuterPrismaDotenv(join(root, "node_modules", ".prisma", "client"));
if (prismaEnv.state === "unverifiable") {
  console.error(
    `[prune-standalone] the Prisma client at ${prismaEnv.path} carries a "relativeEnvPaths" block this rewrite does not recognise — ` +
      "refusing to ship an artifact whose dotenv loading cannot be neutralised (a .env beside the tree would configure the app, including the boot gates). " +
      "Check what @prisma/client changed and update scripts/prune-standalone.mjs; see lib/prisma.ts and docs/deploy.md.",
  );
  process.exit(1);
} else if (prismaEnv.state === "absent") {
  console.log("[prune-standalone] no node_modules/.prisma/client in the tree — nothing to neutralise");
} else if (prismaEnv.patched.length === 0) {
  // Either the rewrite ran in an earlier pass over this tree (idempotent) or
  // the client no longer carries non-null env paths. Both are the desired
  // state; the line says which files were inspected so a silent no-op is
  // visible in the build log the CI gates read.
  console.log("[prune-standalone] Prisma client env paths already null — no dotenv can be loaded at runtime");
} else {
  console.log(
    `[prune-standalone] neutralised the Prisma client's dotenv loading in ${prismaEnv.patched.length} file(s): ${prismaEnv.patched.join(", ")}`,
  );
}

// Next has a dotenv loader of its own (pass 39), and the Prisma rewrite does
// not close it: BaseServer's constructor calls loadEnvConfig(dir, dev) with the
// standalone directory as `dir`, so a `.env` restored beside the artifact is
// parsed at runtime — before instrumentation.ts's boot gates — even though the
// Prisma client can no longer read it. `@next/env`'s processEnv() returns
// immediately when `process.env.__NEXT_PROCESSED_ENV` is set, so setting it at
// the top of the generated server.js (before `require("next")`) makes the
// file's values inert while leaving an operator's real process environment
// untouched. `next start` from the repo is NOT patched: there the dotenv is a
// development feature, and every deployed configuration passes its environment
// explicitly.
function neuterNextDotenv(dir) {
  const p = join(dir, "server.js");
  let src;
  try {
    src = readFileSync(p, "utf8");
  } catch {
    return { state: "absent" };
  }
  if (src.includes("__NEXT_PROCESSED_ENV")) return { state: "ok", patched: false };
  if (!/require\(['"]next['"]\)/.test(src)) return { state: "unverifiable", path: p };
  writeFileSync(
    p,
    `// [pixelduo] runtime dotenv neutralised by scripts/prune-standalone.mjs — see docs/deploy.md\nprocess.env.__NEXT_PROCESSED_ENV = "1"\n${src}`,
  );
  return { state: "ok", patched: true };
}

const nextEnv = neuterNextDotenv(root);
if (nextEnv.state === "unverifiable") {
  console.error(
    `[prune-standalone] ${nextEnv.path} does not look like a Next standalone server (no require('next')) — refusing to ship an artifact whose runtime dotenv loading cannot be neutralised`,
  );
  process.exit(1);
} else if (nextEnv.state === "absent") {
  console.log("[prune-standalone] no server.js in the tree — nothing to neutralise");
} else if (!nextEnv.patched) {
  console.log("[prune-standalone] server.js already neutralises Next's runtime dotenv loading");
} else {
  console.log("[prune-standalone] neutralised Next's runtime dotenv loading in server.js");
}
