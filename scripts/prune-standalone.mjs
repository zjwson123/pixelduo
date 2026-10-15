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
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Optional root argument so a test can point this at a scratch tree.
const root = process.argv[2] ?? ".next/standalone";
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
// file inert. Fail closed if the shape is unrecognised (below).
const NULL_ENV_PATHS = '"relativeEnvPaths": {"rootEnvPath": null, "schemaEnvPath": null}';

function neuterPrismaDotenv(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { state: "absent" };
  }
  const pattern = /"relativeEnvPaths"\s*:\s*\{[^}]*\}/;
  const patched = [];
  for (const name of names) {
    // index.js is the entry (default.js re-exports it); edge.js and wasm.js
    // carry the same config for runtimes this deployment does not use, and a
    // rewrite that skipped them would leave the claim true only by accident.
    if (!name.endsWith(".js")) continue;
    const p = join(dir, name);
    let src;
    try {
      src = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (!src.includes('"relativeEnvPaths"')) continue;
    const match = pattern.exec(src);
    if (!match) {
      // The config exists but not in the shape this rewrite knows. Editing
      // generated code by guesswork could break the client, and leaving it
      // means a .env would be loaded again — so refuse to ship the artifact and
      // let a human look at what Prisma changed. This is the gate; without it
      // the rewrite could silently stop applying after a Prisma upgrade.
      return { state: "unverifiable", path: p };
    }
    if (match[0] === NULL_ENV_PATHS) continue;
    writeFileSync(p, src.replace(pattern, NULL_ENV_PATHS));
    patched.push(p);
  }
  return { state: "ok", patched };
}

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
