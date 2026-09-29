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
// SQLite database at runtime once it is gone (Next only loads dotenv files as a
// convenience for local runs), and every deployed configuration passes its
// environment explicitly — docker compose, or the host's own process environment.
import { readdirSync, rmSync, statSync } from "node:fs";
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

if (removed.length) {
  const size = removed.reduce((a, r) => a + r.size, 0);
  console.log(
    `[prune-standalone] removed ${removed.length} build-host-only file(s) from ${root} (${size} bytes): ${removed.map((r) => r.path).join(", ")}`,
  );
} else {
  console.log(`[prune-standalone] no build-host-only files in ${root}`);
}
